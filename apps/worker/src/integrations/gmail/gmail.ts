import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, ProviderError, gmailProvider } from "@mimir/connection-provider";
import type { ApiRequestOptions, ApiRequestResult } from "@mimir/connection-provider";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";
import { rpc } from "../http-rpc.js";

const prisma = getPrismaClient();

// The Gmail API transport. The ConnectionProvider's apiRequest feeds this:
// Nango injects the token client-side, Composio injects it server-side (proxy
// execute). The REST layer never sees a credential — it only races status + body.
export type GmailTransport = (path: string, opts?: ApiRequestOptions) => Promise<ApiRequestResult>;

export interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  // Signal headers for the importance filter: a List-Unsubscribe marks bulk
  // mailers, an In-Reply-To marks a personal reply within a thread.
  listUnsubscribe?: string;
  inReplyTo?: string;
}

export interface EntityData {
  provider: string;
  messages?: GmailMessage[];
  items?: unknown[];
}

// Real Gmail REST reads behind the mock's exact output shape, so executeAgent's
// LLM prompt path is untouched.
export async function fetchEntityData(userId: string, entity: string | null, taskDescription: string): Promise<EntityData> {
  const e = (entity ?? "").toLowerCase();
  if (!(e.includes("gmail") || /email|mail/i.test(taskDescription))) {
    return { provider: entity ?? "", items: [] };
  }
  const cfg = getConfig();
  const provider = gmailProvider(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
  const transport: GmailTransport = (path, opts) => provider.apiRequest(userId, path, opts);
  return { provider: "gmail", messages: await fetchGmailMessages(transport) };
}

export interface FetchGmailOptions {
  // Gmail search query (the API's `q` param), e.g. "from:openrouter.com". Absent
  // => recent-mail list, not a search.
  query?: string;
  maxResults?: number;
}

// Split from fetchEntityData so the REST layer is unit-testable with a mocked
// transport — no live Nango/Composio/Google account required.
export async function fetchGmailMessages(transport: GmailTransport, opts: FetchGmailOptions = {}): Promise<GmailMessage[]> {
  const list = await rpc<GmailListResponse>(transport, "/gmail/v1/users/me/messages", {
    query: {
      maxResults: opts.maxResults ?? 10,
      ...(opts.query ? { q: opts.query } : {}),
    },
  });
  const messages: GmailMessage[] = [];
  for (const row of list.messages ?? []) {
    const detail = await rpc<GmailDetailResponse>(transport, `/gmail/v1/users/me/messages/${row.id}`, {
      query: { format: "metadata" },
    });
    const listUnsubscribe = headerValue(detail.payload, "List-Unsubscribe");
    const inReplyTo = headerValue(detail.payload, "In-Reply-To");
    messages.push({
      id: row.id,
      from: headerValue(detail.payload, "From"),
      subject: headerValue(detail.payload, "Subject"),
      body: detail.snippet ?? "",
      receivedAt: toIso(detail.internalDate),
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
    });
  }
  return messages;
}

// Composite Task: one aggregated "search my Gmail" result from a real
// Gmail query — the Execution Agent translates its ask into Gmail search syntax
// (from:/subject:/keyword) and this hits messages.list?q=... for real matches.
export function gmailSearchTask(): Task {
  return {
    kind: "task",
    name: "search_email",
    description:
      "Search the user's Gmail for messages matching a Gmail search query (e.g. 'from:openrouter.com', 'subject:invoice', 'has:attachment'). Returns real matches from Gmail's search API with sender and subject. Use this to answer whether specific mail exists; an empty result means no match for that query, so try a broader query before concluding there is none.",
    inputSchema: z.object({
      query: z.string().describe("Gmail search query, e.g. 'from:openrouter.com' or 'subject:invoice'"),
    }),
    execute: async (input, ctx) => {
      const { query } = input as { query: string };
      if (!query?.trim()) throw new ToolError("validation", "search_email requires a query");
      const cfg = getConfig();
      const provider = gmailProvider(cfg, prisma.integrationConnection, `${cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? ""}/api/v1/integrations/gmail/callback`);
      const transport: GmailTransport = (path, opts) => provider.apiRequest(ctx.userId, path, opts);
      try {
        return { provider: "gmail", query, messages: await fetchGmailMessages(transport, { query, maxResults: 20 }) };
      } catch (e) {
        if (e instanceof ConnectionError) throw new ToolError("connection", e.message);
        if (e instanceof ProviderError) throw new ToolError("execution", e.message);
        throw e;
      }
    },
  };
}

export interface GmailWatchResult {
  expiration: number;
  historyId: string;
}

// Gmail push watch registration. Requires a Pub/Sub topic (Google Cloud)
// reachable by the Gmail account; the user's OAuth token authorizes the watch
// against the shared topic. Gmail expiring the watch (~7 days) is handled by the
// renewal sweep.
export async function registerGmailWatch(transport: GmailTransport, topicName: string): Promise<GmailWatchResult> {
  const watch = await rpc<{ expiration?: number; historyId?: string }>(transport, "/gmail/v1/users/me/watch", {
    method: "POST",
    body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
  });
  if (!watch.historyId) throw new ProviderError("malformed_response", "gmail watch missing historyId");
  return { expiration: watch.expiration ?? 0, historyId: watch.historyId };
}

export interface GmailDraftMessage {
  from: string;
  to: string;
  subject: string;
  body: string;
}

// Send path (interactive chat, draft-then-confirm): the email is created as a
// Gmail draft at proposal time so a cancel leaves it sitting in the user's
// Drafts folder; confirming sends that exact draft via drafts/send.
export async function getGmailProfile(transport: GmailTransport): Promise<string> {
  const profile = await rpc<{ emailAddress?: string }>(transport, "/gmail/v1/users/me/profile");
  if (!profile.emailAddress) throw new ProviderError("malformed_response", "gmail profile missing emailAddress");
  return profile.emailAddress;
}

export async function createGmailDraft(transport: GmailTransport, msg: GmailDraftMessage): Promise<{ id: string; messageId: string }> {
  const draft = await rpc<{ id?: string; message?: { id?: string } }>(transport, "/gmail/v1/users/me/drafts", {
    method: "POST",
    body: { message: { raw: Buffer.from(buildRawMessage(msg), "utf8").toString("base64url") } },
  });
  if (!draft.id || !draft.message?.id) throw new ProviderError("malformed_response", "gmail draft missing id");
  return { id: draft.id, messageId: draft.message.id };
}

export async function sendGmailDraft(transport: GmailTransport, draftId: string): Promise<string> {
  const sent = await rpc<{ id?: string }>(transport, "/gmail/v1/users/me/drafts/send", {
    method: "POST",
    body: { id: draftId },
  });
  if (!sent.id) throw new ProviderError("malformed_response", "gmail send missing message id");
  return sent.id;
}

// An edit supersedes the previously proposed draft: delete it from Gmail so
// repeated corrections don't pile up orphaned copies. Gmail returns 204 with an
// empty body on delete.
export async function deleteGmailDraft(transport: GmailTransport, draftId: string): Promise<void> {
  await rpc<undefined>(transport, `/gmail/v1/users/me/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
}

// RFC 2822 raw message for Gmail. Subject uses RFC 2047 B-encoding when it
// carries non-ASCII; the body is base64 under a UTF-8 text/plain part so any
// charset survives the API round-trip.
export function buildRawMessage(msg: GmailDraftMessage): string {
  const header = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${encodeSubject(msg.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].join("\r\n");
  return `${header}\r\n\r\n${Buffer.from(msg.body, "utf8").toString("base64")}`;
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

interface GmailListResponse {
  messages?: { id: string }[];
}

interface GmailDetailResponse {
  snippet?: string | null;
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

function headerValue(payload: { headers?: { name?: string; value?: string }[] } | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

// internalDate is epoch millis; a garbage value shouldn't kill the whole run.
function toIso(internalDate: unknown): string {
  const n = Number(internalDate);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : "";
}
