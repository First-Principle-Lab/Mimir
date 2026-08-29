import { getConfig, getLogger, getPrismaClient } from "@mimir/backend-core";
import {
  COMPOSIO_KEYS,
  GITHUB_INTEGRATION,
  GMAIL_INTEGRATION,
  GOOGLE_CALENDAR_INTEGRATION,
  INTERCOM_INTEGRATION,
  LINEAR_INTEGRATION,
  NOTION_INTEGRATION,
  NotConfiguredError,
  SENTRY_INTEGRATION,
  VERCEL_INTEGRATION,
  composioProvider,
  gmailProvider,
  providerFor,
} from "@mimir/connection-provider";
import type { ApiRequestOptions, ApiRequestResult, ConnectionProvider } from "@mimir/connection-provider";
import { Router } from "express";
import { requireAuth } from "../auth/auth.js";

const cfg = getConfig();
const prisma = getPrismaClient();
const store = prisma.integrationConnection;
const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
const gmailCallbackUrl = `${webBase}/api/v1/integrations/gmail/callback`;

// The managed-integration roster, all driven through the same
// ConnectionProvider abstraction. A settings page renders this list.
// Gmail's roster key is "google-mail" (Nango's id) but its dedicated route
// prefix is "gmail" — the two entry points are handled separately below.
const ROSTER = [
  { key: GMAIL_INTEGRATION, label: "Gmail" },
  { key: GOOGLE_CALENDAR_INTEGRATION, label: "Google Calendar" },
  { key: GITHUB_INTEGRATION, label: "GitHub" },
  { key: NOTION_INTEGRATION, label: "Notion" },
  { key: LINEAR_INTEGRATION, label: "Linear" },
  { key: VERCEL_INTEGRATION, label: "Vercel" },
  { key: INTERCOM_INTEGRATION, label: "Intercom" },
  { key: SENTRY_INTEGRATION, label: "Sentry" },
];

// The provider instance for a roster key. Gmail goes through the swap factory
// (Composio preferred, Nango rollback); the calendar/github/notion trio is
// Composio-only; the rest of the roster stays Nango-backed.
function providerForKey(key: string): ConnectionProvider {
  if (key === GMAIL_INTEGRATION) return gmailProvider(cfg, store, gmailCallbackUrl);
  if (COMPOSIO_KEYS.includes(key)) {
    return composioProvider(key, cfg, store, `${webBase}/api/v1/integrations/${key}/callback`);
  }
  return providerFor(key)({
    secretKey: cfg.NANGO_SECRET_KEY,
    host: cfg.NANGO_BASE_URL,
    store,
  });
}

// Nango's API surfaces structured failures on createConnectSession (the Auth
// error payload is delivered in the Connect UI even when the server call 400s).
// Map the common ones to a status the server actually returns + a message the
// UI can show instead of a raw AxiosError. `resource_capped` is an account/hard
// connection limit, not a config bug — don't hide it behind "try again".
function mapConnectError(e: unknown): { status: number; code: string; message: string } {
  const data = (e as { response?: { status?: number; data?: { error?: { code?: string; message?: string } } } })?.response?.data;
  const code = data?.error?.code;
  const raw = data?.error?.message;
  if (code === "resource_capped") {
    return {
      status: 429,
      code: "CONNECT_LIMIT",
      message: "This workspace has hit its connection limit. Disconnect an unused integration in Nango, or upgrade the plan.",
    };
  }
  return {
    status: 502,
    code: "CONNECT_FAILED",
    message: raw ? `Couldn't start the connect flow: ${raw}` : "Couldn't start the connect flow. Is Nango configured?",
  };
}

export const integrationsRouter: Router = Router();

// Dedicated Gmail routes FIRST — the generic /integrations/:providerKey routes
// below would otherwise shadow these (the roster uses key `google-mail`, while
// the chat UI calls `gmail`; a generic match would 404 "unknown integration").
// POST /api/v1/integrations/gmail/connect — initiate the OAuth flow. Nango
// returns a sessionToken for its in-page Connect UI; Composio returns an
// authorizationUrl to redirect the browser to. The UI picks whichever is present.
// POST (not GET) so the browser never caches the minted OAuth session — a cached
// GET 304 would hand back a stale/empty body instead of a fresh connect URL.
integrationsRouter.post("/integrations/gmail/connect", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  try {
    const { sessionToken, authorizationUrl } = await gmailProvider(cfg, store, gmailCallbackUrl).initiateOAuth(userId);
    res.json({ sessionToken, authorizationUrl });
  } catch (e) {
    // Composio's SDK refuses to mint a link when the user already has an ACTIVE
    // connected account (without allowMultiple). That's not a config failure —
    // surface it as a state refresh, not the misleading "Is Nango configured?".
    if ((e as Error)?.name === "ComposioMultipleConnectedAccountsError") {
      res.json({ alreadyConnected: true });
      return;
    }
    // Neither Composio nor Nango configured — don't misdirect with the generic
    // "Is Nango configured?" from mapConnectError.
    if (e instanceof NotConfiguredError) {
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: e.message } });
      return;
    }
    getLogger().error({ err: e, userId, provider: "gmail" }, "gmail connect session failed");
    const err = mapConnectError(e);
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
});
// GET /api/v1/integrations/gmail/callback — the provider's OAuth success URL.
// Session cookie rides the same browser so req.userId is available. Composio
// appends ?status=success&connected_account_id=ca_x; forwarded to handleCallback.
// Always redirect back to the app; a failed upsert is logged, not fatal.
integrationsRouter.get("/integrations/gmail/callback", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const connectedAccountId = (req.query.connected_account_id as string | undefined) ?? (req.query.connectionId as string | undefined);
  try {
    await gmailProvider(cfg, store, gmailCallbackUrl).handleCallback(userId, connectedAccountId);
    getLogger().info({ userId }, "gmail connection stored");
  } catch (e) {
    getLogger().error({ err: e, userId }, "gmail callback failed");
  }
  res.redirect(`${cfg.WEB_APP_URL ?? ""}/chat`);
});

// GET /api/v1/integrations/gmail — status the UI renders the connect link from.
// If no connected row exists, reconcile against the provider: the row may be
// missing (tab closed mid-flow) OR stale (worker flips it to "expired" on a
// transient token error while Composio still has the account ACTIVE). Both are
// healed here so chat and the settings panel agree.
integrationsRouter.get("/integrations/gmail", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const provider = gmailProvider(cfg, store, gmailCallbackUrl);
  let connection = await provider.getConnection(userId);
  if (connection?.status !== "connected") {
    try {
      await provider.syncConnection(userId);
    } catch (e) {
      getLogger().error({ err: e, userId }, "gmail reconciliation failed");
    }
    connection = await provider.getConnection(userId);
  }
  res.json({ connected: connection?.status === "connected" });
});

// POST /api/v1/integrations/gmail/disconnect — revoke the Nango connection + drop
// the local row so the UI flips back to disconnected (chat page uses `gmail`).
integrationsRouter.post("/integrations/gmail/disconnect", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  await gmailProvider(cfg, store, gmailCallbackUrl).revoke(userId);
  getLogger().info({ userId }, "gmail connection revoked");
  res.json({ connected: false });
});

// GET /api/v1/integrations — the full roster with per-provider connected status
// (one settings page, not one page per provider). Reconciles each
// non-connected entry against its provider so this panel agrees with the chat
// page's per-provider status route (both treat only status === "connected" as
// connected — a stale "expired" row is healed, not shown as disconnected).
integrationsRouter.get("/integrations", requireAuth, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  const rows = await prisma.integrationConnection.findMany({ where: { userId }, select: { provider: true, status: true } });
  const statusByKey = new Map(rows.map((r) => [r.provider, r.status]));
  for (const r of ROSTER) {
    if (statusByKey.get(r.key) === "connected") continue;
    const provider = providerForKey(r.key);
    try {
      if (await provider.syncConnection(userId)) statusByKey.set(r.key, "connected");
    } catch (e) {
      getLogger().error({ err: e, userId, provider: r.key }, "integration reconciliation failed");
    }
  }
  const nango = cfg.NANGO_SECRET_KEY != null;
  res.json({
    nangoConfigured: nango,
    integrations: ROSTER.map((r) => ({ ...r, connected: statusByKey.get(r.key) === "connected" })),
  });
});

// POST /api/v1/integrations/:providerKey/connect — connect-session/redirect for
// any roster provider. Gmail + calendar/github/notion are Composio-backed (the
// swap factory for gmail, the composioProvider factory for the rest); Linear/
// Vercel/Intercom/Sentry stay Nango. Responds with sessionToken (Nango's in-page
// widget) and/or authorizationUrl (Composio redirect).
integrationsRouter.post("/integrations/:providerKey/connect", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  // Only the Nango-backed roster needs NANGO_SECRET_KEY — Composio keys mint a
  // link from COMPOSIO_API_KEY and 502 from NotConfiguredError inside the factory.
  if (key !== GMAIL_INTEGRATION && !COMPOSIO_KEYS.includes(key) && !cfg.NANGO_SECRET_KEY) {
    res.status(503).json({ error: { code: "NOT_CONFIGURED", message: "Integrations are not configured" } });
    return;
  }
  const provider = providerForKey(key);
  try {
    const { sessionToken, authorizationUrl } = await provider.initiateOAuth(userId);
    res.json({ sessionToken, authorizationUrl });
  } catch (e) {
    // Composio refuses to mint a link when the user already has an ACTIVE
    // connected account (without allowMultiple) — surface as a refresh, not a
    // config failure. Mirrors the gmail route's dedicated handler.
    if ((e as Error)?.name === "ComposioMultipleConnectedAccountsError") {
      res.json({ alreadyConnected: true });
      return;
    }
    // Missing COMPOSIO_API_KEY or the toolkit's auth config id — the laconic
    // 502 below would wrongly tell the user "Is Nango configured?". Name the
    // actual gap instead.
    if (e instanceof NotConfiguredError) {
      res.status(503).json({ error: { code: "NOT_CONFIGURED", message: e.message } });
      return;
    }
    getLogger().error({ err: e, userId, provider: key }, "connect session failed");
    const err = mapConnectError(e);
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
  }
});

// GET /api/v1/integrations/:providerKey/callback — the Composio OAuth success
// URL for the generic roster keys. Composio appends
// ?status=success&connected_account_id=ca_x, which is forwarded to
// handleCallback. Nango-backed providers have no server redirect (their connect
// UI closes in-page), so this route 404s for those keys. Always redirects back
// to the app; a failed upsert is logged, never fatal.
integrationsRouter.get("/integrations/:providerKey/callback", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key) || (key !== GMAIL_INTEGRATION && !COMPOSIO_KEYS.includes(key))) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "no callback for this integration" } });
    return;
  }
  const connectedAccountId = (req.query.connected_account_id as string | undefined) ?? (req.query.connectionId as string | undefined);
  try {
    await providerForKey(key).handleCallback(userId, connectedAccountId);
    getLogger().info({ userId, provider: key }, "integration connection stored");
    // GitHub webhook coverage should start within seconds, not at the next
    // daily self-heal sweep. Enqueue a one-off registration via the outbox
    // (worker owns the GitHub API call; this route only writes a durable row —
    // the same shape as every other api->worker handoff in this codebase).
    if (key === GITHUB_INTEGRATION) {
      await prisma.outboxEvent.create({
        data: { eventType: "github_hook_register", payload: { userId } },
      });
      getLogger().info({ userId }, "github hook registration enqueued");
    }
  } catch (e) {
    getLogger().error({ err: e, userId, provider: key }, "integration callback failed");
  }
  res.redirect(`${cfg.WEB_APP_URL ?? ""}/chat`);
});

// POST /api/v1/integrations/:providerKey/disconnect — revoke any roster provider.
// Does NOT require NANGO_SECRET_KEY: revoke() drops the local row even if the
// Nango call fails.
integrationsRouter.post("/integrations/:providerKey/disconnect", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  // GitHub: delete the repo webhooks we registered before dropping the row,
  // so a disconnect stops GitHub push deliveries, not just our local state.
  if (key === GITHUB_INTEGRATION) {
    const conn = await prisma.integrationConnection.findFirst({
      where: { userId, provider: GITHUB_INTEGRATION },
    });
    const hooks = ((conn?.webhookMeta ?? {}) as { hooks?: { repo: string; id: number; url: string }[] }).hooks ?? [];
    const request: (path: string, opts?: ApiRequestOptions) => Promise<ApiRequestResult> = (path, opts) =>
      providerForKey(key).apiRequest(userId, path, opts);
    for (const hook of hooks) {
      await request(`/repos/${hook.repo}/hooks/${hook.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  await providerForKey(key).revoke(userId);
  getLogger().info({ userId, provider: key }, "integration revoked");
  res.json({ connected: false, key });
});

// GET /api/v1/integrations/:providerKey — per-provider connected status.
integrationsRouter.get("/integrations/:providerKey", requireAuth, async (req, res) => {
  const userId = req.userId;
  const key = String(req.params.providerKey);
  if (!userId) {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Not authenticated" } });
    return;
  }
  if (!ROSTER.some((r) => r.key === key)) {
    res.status(404).json({ error: { code: "NOT_FOUND", message: "unknown integration" } });
    return;
  }
  const connection = await providerForKey(key).getConnection(userId);
  res.json({ connected: connection != null, key });
});

