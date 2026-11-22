import {
  getConfig,
  getPrismaClient,
  type InputJsonValue,
} from "@mimir/backend-core";
import {
  composioProvider,
  gmailProvider,
  GMAIL_INTEGRATION,
  GOOGLE_CALENDAR_INTEGRATION,
  GITHUB_INTEGRATION,
  NOTION_INTEGRATION,
} from "@mimir/connection-provider";
import { ToolError } from "@mimir/tasks";
import { z } from "zod";
import { rpc, type RequestFn } from "../integrations/http-rpc.js";
import { buildRawMessage } from "../integrations/gmail/gmail.js";
import { browserSubmitSpec } from "../integrations/browser/browser-write.js";
import { argumentHash } from "./actions.js";
import type { ToolRisk, ToolRunContext, ToolSpec } from "./tools.js";

const prisma = getPrismaClient();
export type WriteTransportFactory = (
  provider: string,
  userId: string,
) => RequestFn;
export const writeTransport: WriteTransportFactory = (integration, userId) => {
  const cfg = getConfig();
  const callback =
    (cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "") +
    "/api/v1/integrations/" +
    integration +
    "/callback";
  const provider =
    integration === GMAIL_INTEGRATION
      ? gmailProvider(cfg, prisma.integrationConnection, callback)
      : composioProvider(
          integration,
          cfg,
          prisma.integrationConnection,
          callback,
        );
  return (path, opts) => provider.apiRequest(userId, path, opts);
};
const json = (value: unknown): InputJsonValue =>
  JSON.parse(JSON.stringify(value));
const email = z.strictObject({
  to: z.email().max(320),
  subject: z
    .string()
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject cannot contain newlines"),
  body: z.string().min(1).max(32000),
});
const draftRef = z.strictObject({ draftId: z.string().min(1) });
const sendArgs = draftRef.extend(email.shape);
const eventFields = {
  calendarId: z.string().min(1).max(320).default("primary"),
  summary: z.string().min(1).max(1000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  description: z.string().max(8000).optional(),
  attendees: z.array(z.email()).max(50).default([]),
};
const eventCreate = z
  .strictObject(eventFields)
  .refine(
    (a) => Date.parse(a.end) > Date.parse(a.start),
    "End must be after start",
  );
const eventUpdate = z
  .strictObject({ ...eventFields, eventId: z.string().min(1).max(1024) })
  .refine(
    (a) => Date.parse(a.end) > Date.parse(a.start),
    "End must be after start",
  );
const repo = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
  .refine((r) => !r.split("/").some((p) => p === "." || p === ".."));
const issueCreate = z.strictObject({
  repo,
  title: z.string().min(1).max(1000),
  body: z.string().max(32000).default(""),
});
const issueComment = z.strictObject({
  repo,
  number: z.number().int().positive(),
  body: z.string().min(1).max(32000),
});
const issueUpdate = z.strictObject({
  repo,
  number: z.number().int().positive(),
  title: z.string().min(1).max(1000).optional(),
  body: z.string().max(32000).optional(),
  state: z.enum(["open", "closed"]).optional(),
});
const notionCreate = z.strictObject({
  parentPageId: z.uuid(),
  title: z.string().min(1).max(2000),
  text: z.string().max(2000).default(""),
});
const notionUpdate = z.strictObject({
  pageId: z.uuid(),
  title: z.string().min(1).max(2000),
});
function spec(
  name: string,
  label: string,
  description: string,
  schema: z.ZodType,
  execute: (args: never, ctx: ToolRunContext) => Promise<unknown>,
  risk: ToolRisk = "communicate_external",
): ToolSpec {
  return {
    name,
    label,
    description,
    parameters: schema.toJSONSchema(),
    risk,
    sideEffect: "irreversible",
    idempotent: false,
    provenance: "mimir:write/" + name + "@1",
    resultTrust: "untrusted",
    outputMaxChars: 12000,
    deferred: true,
    prepare: (raw) => json(schema.parse(raw)),
    execute: (raw, ctx) => execute(schema.parse(raw) as never, ctx),
  };
}

export async function writeToolsFor(
  userId: string,
  transports: WriteTransportFactory = writeTransport,
): Promise<ToolSpec[]> {
  const connected = new Set(
    (
      await prisma.integrationConnection.findMany({
        where: { userId, status: "connected" },
        select: { provider: true },
      })
    ).map((c) => c.provider),
  );
  const tools: ToolSpec[] = [browserSubmitSpec()];
  if (connected.has(GMAIL_INTEGRATION)) {
    const draft = spec(
      "email_draft",
      "Save email draft",
      "Save an unsent email draft in Mimir. This does not send mail. Use for unattended outbound mail; only a later approved email_send can deliver it.",
      email,
      async (args: z.infer<typeof email>, ctx) => {
        const id = "draft-" + argumentHash([ctx.runId, args]);
        const row = await prisma.emailDraft.upsert({
          where: { id },
          create: {
            id,
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            ...args,
          },
          update: {},
        });
        return {
          draftId: row.id,
          status: row.status,
          to: row.to,
          subject: row.subject,
          body: row.body,
        };
      },
      "write_reversible_self",
    );
    draft.provenance = "mimir:harness/internal";
    draft.sideEffect = "reversible";
    draft.idempotent = true;
    draft.resultTrust = "trusted";
    draft.deferred = false;
    const send = spec(
      "email_send",
      "Send email draft",
      "Request approval to send an existing Mimir draft. Pass draftId from email_draft. The card contains the exact recipient, subject and body. The draft remains unsent until that card is approved.",
      sendArgs,
      async (args: z.infer<typeof sendArgs>, ctx) => {
        const current = await prisma.emailDraft.findFirst({
          where: {
            id: args.draftId,
            userId: ctx.userId,
            conversationId: ctx.conversationId,
            status: "draft",
          },
        });
        if (
          !current ||
          current.to !== args.to ||
          current.subject !== args.subject ||
          current.body !== args.body
        )
          throw new Error(
            "Draft changed or is no longer available; no message sent",
          );
        // Omit From: Gmail uses the authenticated connected account. Recipient,
        // subject and body come only from the approved immutable snapshot.
        const raw = buildRawMessage({
          from: "",
          to: args.to,
          subject: args.subject,
          body: args.body,
        }).replace(/^From:.*\r\n/, "");
        const sent = await rpc<{ id?: string }>(
          transports(GMAIL_INTEGRATION, ctx.userId),
          "/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            body: { raw: Buffer.from(raw).toString("base64url") },
          },
        );
        if (!sent.id)
          throw new Error(
            "Gmail did not return a message ID; verify the Sent folder",
          );
        await prisma.emailDraft.update({
          where: { id: current.id },
          data: { status: "sent" },
        });
        return { sent: true, messageId: sent.id, draftId: current.id };
      },
    );
    send.deferred = false;
    send.prepare = async (raw, ctx) => {
      const { draftId } = draftRef.parse({
        draftId: (raw as { draftId?: unknown })?.draftId,
      });
      const row = await prisma.emailDraft.findFirst({
        where: {
          id: draftId,
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          status: "draft",
        },
      });
      if (!row)
        throw new ToolError(
          "validation",
          "Unsent draft not found in this conversation",
        );
      return sendArgs.parse({
        draftId,
        to: row.to,
        subject: row.subject,
        body: row.body,
      });
    };
    send.parameters = draftRef.toJSONSchema();
    send.idempotencyKey = (raw, ctx) =>
      "email-send:" + ctx.userId + ":" + sendArgs.parse(raw).draftId;
    tools.push(draft, send);
  }
  if (connected.has(GOOGLE_CALENDAR_INTEGRATION)) {
    const save = async (
      a: z.infer<typeof eventUpdate> | z.infer<typeof eventCreate>,
      ctx: ToolRunContext,
    ) => {
      const id = "eventId" in a ? a.eventId : undefined;
      return rpc(
        transports(GOOGLE_CALENDAR_INTEGRATION, ctx.userId),
        "/calendars/" +
          encodeURIComponent(a.calendarId) +
          "/events" +
          (id ? "/" + encodeURIComponent(id) : ""),
        {
          method: id ? "PATCH" : "POST",
          query: { sendUpdates: a.attendees.length ? "all" : "none" },
          body: {
            summary: a.summary,
            description: a.description,
            start: { dateTime: a.start },
            end: { dateTime: a.end },
            attendees: a.attendees.map((email) => ({ email })),
          },
        },
      );
    };
    const create = spec(
      "calendar_create_event",
      "Create calendar event",
      "Create an event with explicit start/end UTC offsets. Invitations and non-primary calendars require approval; a private primary-calendar event with no attendees is a reversible self edit. Never infer additional attendees.",
      eventCreate,
      save,
      "write_reversible_self",
    );
    create.sideEffect = "reversible";
    create.effectiveRisk = (raw) =>
      (raw as { attendees?: unknown[] })?.attendees?.length ||
      ((raw as { calendarId?: string })?.calendarId &&
        (raw as { calendarId?: string }).calendarId !== "primary")
        ? "communicate_external"
        : "write_reversible_self";
    tools.push(
      create,
      spec(
        "calendar_update_event",
        "Update calendar event",
        "Update the specified event using the exact reviewed details. All updates require approval because an existing event may have other attendees.",
        eventUpdate,
        save,
      ),
    );
  }
  if (connected.has(GITHUB_INTEGRATION)) {
    const req = (ctx: ToolRunContext) =>
      transports(GITHUB_INTEGRATION, ctx.userId);
    tools.push(
      spec(
        "github_create_issue",
        "Create GitHub issue",
        "Create an issue in the specified owner/repo. Requires approval of the exact repository, title and body.",
        issueCreate,
        (a: z.infer<typeof issueCreate>, ctx) =>
          rpc(req(ctx), "/repos/" + a.repo + "/issues", {
            method: "POST",
            body: { title: a.title, body: a.body },
          }),
      ),
      spec(
        "github_comment_issue",
        "Comment on GitHub issue",
        "Post a comment to one issue or pull request. Requires approval.",
        issueComment,
        (a: z.infer<typeof issueComment>, ctx) =>
          rpc(
            req(ctx),
            "/repos/" + a.repo + "/issues/" + a.number + "/comments",
            { method: "POST", body: { body: a.body } },
          ),
      ),
      spec(
        "github_update_issue",
        "Update GitHub issue",
        "Edit or close an issue. Requires approval of the exact changes.",
        issueUpdate,
        (a: z.infer<typeof issueUpdate>, ctx) =>
          rpc(req(ctx), "/repos/" + a.repo + "/issues/" + a.number, {
            method: "PATCH",
            body: { title: a.title, body: a.body, state: a.state },
          }),
        "destructive",
      ),
    );
  }
  if (connected.has(NOTION_INTEGRATION)) {
    const headers = { "Notion-Version": "2022-06-28" };
    const title = (text: string) => [{ type: "text", text: { content: text } }];
    tools.push(
      spec(
        "notion_create_page",
        "Create Notion page",
        "Create a page under the specified parent. Requires approval since the workspace may be shared.",
        notionCreate,
        (a: z.infer<typeof notionCreate>, ctx) =>
          rpc(transports(NOTION_INTEGRATION, ctx.userId), "/v1/pages", {
            method: "POST",
            headers,
            body: {
              parent: { page_id: a.parentPageId },
              properties: { title: { title: title(a.title) } },
              children: a.text
                ? [
                    {
                      object: "block",
                      type: "paragraph",
                      paragraph: { rich_text: title(a.text) },
                    },
                  ]
                : [],
            },
          }),
      ),
      spec(
        "notion_update_page",
        "Rename Notion page",
        "Change the title of the specified Notion page. Requires approval of the page ID and title.",
        notionUpdate,
        (a: z.infer<typeof notionUpdate>, ctx) =>
          rpc(
            transports(NOTION_INTEGRATION, ctx.userId),
            "/v1/pages/" + a.pageId,
            {
              method: "PATCH",
              headers,
              body: { properties: { title: { title: title(a.title) } } },
            },
          ),
      ),
    );
  }
  return tools;
}
