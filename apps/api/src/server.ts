import { getConfig, getLogger, getPrismaClient, runWithContext, tracer } from "@mimir/backend-core";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import passport from "passport";
import { setupExpressErrorHandler } from "@sentry/node";
import { authRouter } from "./auth/auth.js";
import { integrationsRouter } from "./routes/integrations.js";
import { messageRouter } from "./routes/message.js";
import { mcpRouter } from "./routes/mcp.js";
import { pushRouter } from "./routes/push.js";
import { userRouter } from "./routes/user.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { redis } from "./infra/redis.js";
import { initPubSub, initSocket } from "./infra/socket.js";

const config = getConfig();
const app = express();
const prisma = getPrismaClient();

app.use((req, res, next) => {
  const requestId = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  const startedAt = performance.now();
  res.setHeader("x-request-id", requestId);
  const span = tracer.startSpan(`http ${req.method} ${req.path}`, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": req.method,
      "url.path": req.path,
      "requestId": requestId,
    },
  });
  res.on("finish", () => {
    const durationMs = Math.round(performance.now() - startedAt);
    span.setAttribute("http.response.status_code", res.statusCode);
    if (res.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    getLogger().info({ method: req.method, path: req.path, status: res.statusCode, durationMs }, "request");
  });
  res.on("close", () => span.end());
  runWithContext({ requestId }, () => context.with(trace.setSpan(context.active(), span), next));
});

// Webhook HMACs (GitHub/Slack) need the pre-parsed raw body. `express.json`'s
// verify hook captures the raw bytes WITHOUT consuming the stream, so req.body
// is still parsed for the handlers — the manual data-listener approach would
// drain the stream and leave req.body undefined on every /webhooks POST.
app.use("/webhooks", express.json({ verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString("utf8"); } }));
app.use(express.json());

// CORS for the static-export web app (different origin/port). Reflect only
// known origins; always allow credentials (cookie-based auth).
// tauri://localhost — packaged desktop app origin, required for any desktop auth to work at all.
const allowedOrigins = new Set(
  [config.WEB_APP_URL, "http://localhost:3000", "tauri://localhost"].filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(passport.initialize());
app.use("/api/v1/auth", authRouter);
app.use("/api/v1", integrationsRouter);
app.use("/api/v1", messageRouter);
app.use("/api/v1", mcpRouter);
app.use("/api/v1", pushRouter);
app.use("/api/v1", userRouter);
app.use("/webhooks", webhooksRouter());

app.get("/health", async (_req, res) => {
  let db = "ok";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    db = "error";
  }
  let cache = "ok";
  try {
    if ((await redis.ping()) !== "PONG") cache = "error";
  } catch {
    cache = "error";
  }
  const ok = db === "ok" && cache === "ok";
  getLogger().info({ checks: { db, redis: cache } }, "health check");
  // commit lets the deploy workflow wait until the new version is the one answering.
  res.status(ok ? 200 : 503).json({
    status: ok ? "ok" : "degraded",
    checks: { db, redis: cache },
    commit: process.env.RENDER_GIT_COMMIT ?? null,
  });
});

setupExpressErrorHandler(app);

const server = createServer(app);
initSocket(server);
initPubSub(redis.duplicate());
server.listen(config.PORT, () => {
  getLogger().info({ port: config.PORT }, "@mimir/api listening");
});
