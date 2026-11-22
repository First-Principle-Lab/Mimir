import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  getLogger,
  getPrismaClient,
  HARNESS_FACTS_MIN_MESSAGES,
  HARNESS_LOCK_TTL_MS,
  HARNESS_LEGACY_HISTORY_LIMIT,
  HARNESS_TURN_TIMEOUT_MS,
  rollDailyUsage,
  searchActiveFactsWithRelations,
  trackEvent,
  trackModelCall,
  type FactHit,
  type InputJsonValue,
} from "@mimir/backend-core";
import { DelayedError, type Job } from "bullmq";
import { newMessagePayload, publishUserEvent, redis } from "../infra/redis.js";
import { buildRuntimeContext } from "./context.js";
import { ModelNotAvailableError } from "./pi-runtime.js";
import { SessionHost } from "./session-host.js";
import { readToolsFor } from "./tools.js";

// Eval runs use synthetic account data and a fixed clock while executing the
// same locking, journaling, session, and delivery code as production.
export interface TurnOptions {
  readTools?: typeof readToolsFor;
  now?: () => Date;
}

const prisma = getPrismaClient();

export interface TurnJobData {
  conversationId: string;
  userId: string;
  messageId: string;
}

// Thrown when another process holds the conversation's run lock; BullMQ retries
// the job with backoff until that run finishes.
export class ConversationBusyError extends Error {
  constructor(conversationId: string) {
    super(`conversation ${conversationId} has a run in progress elsewhere`);
    this.name = "ConversationBusyError";
  }
}

const sessions = new SessionHost();
const RENEW_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`;

const FALLBACK_REPLY = "Sorry, I couldn't get to that one. Mind trying again?";
const UNAVAILABLE_REPLY =
  "I can't reply right now: my model isn't available. Please try again in a bit.";

const lockKey = (conversationId: string) => `harness-lock:${conversationId}`;

async function acquireLock(conversationId: string): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(
    lockKey(conversationId),
    token,
    "PX",
    HARNESS_LOCK_TTL_MS,
    "NX",
  );
  return ok === "OK" ? token : null;
}

const RELEASE_LUA = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

async function releaseLock(
  conversationId: string,
  token: string,
): Promise<void> {
  await redis
    .eval(RELEASE_LUA, 1, lockKey(conversationId), token)
    .catch((e) =>
      getLogger().warn(
        { err: e, conversationId },
        "harness lock release failed; it expires on its own",
      ),
    );
}

async function startRun(data: TurnJobData): Promise<string> {
  const run = await prisma.agentRun.upsert({
    where: { inputMessageId: data.messageId },
    create: {
      conversationId: data.conversationId,
      userId: data.userId,
      trigger: "user_message",
      inputMessageId: data.messageId,
    },
    update: { status: "running", error: undefined, finishedAt: null },
  });
  return run.id;
}

// Text of an assistant message, or "" when it has none (tool-only, error, aborted).
function assistantText(message: unknown): string {
  const m = message as {
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  if (m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("")
    .trim();
}

// Pair each user input added during the run with the last assistant text that
// follows it (before the next user input). Inputs are in pi's order: the first
// prompt, then follow-ups.
export function repliesByInput(
  messages: readonly unknown[],
  fromIndex: number,
  inputCount: number,
): string[] {
  const replies: string[] = [];
  let current = -1;
  for (let i = fromIndex; i < messages.length; i++) {
    const m = messages[i] as { role?: string };
    if (m.role === "user") {
      current += 1;
      replies[current] = "";
    } else if (current >= 0) {
      const text = assistantText(m);
      if (m.role === "assistant") replies[current] = text;
    }
  }
  while (replies.length < inputCount) replies.push("");
  return replies.slice(0, inputCount);
}

async function writeReply(opts: {
  conversationId: string;
  userId: string;
  inputMessageId: string;
  content: string;
  runId: string;
  failed: boolean;
  model?: string;
  usage: RunUsage;
  durationMs: number;
}): Promise<string> {
  const reply = await prisma.$transaction(async (tx) => {
    const message = await tx.message.create({
      data: {
        conversationId: opts.conversationId,
        role: "assistant",
        content: opts.content,
        status: "complete",
        model: opts.model,
        tokenCount: opts.usage.promptTokens + opts.usage.completionTokens,
        promptTokens: opts.usage.promptTokens,
        completionTokens: opts.usage.completionTokens,
        durationMs: opts.durationMs,
        parentMessageId: opts.inputMessageId,
        errorDetail: opts.failed ? { reason: "no_reply" } : undefined,
      },
    });
    await tx.agentRun.update({
      where: { id: opts.runId },
      data: {
        status: opts.failed ? "failed" : "succeeded",
        replyMessageId: message.id,
        model: opts.model,
        steps: opts.usage.steps,
        toolCalls: opts.usage.toolCalls,
        promptTokens: opts.usage.promptTokens,
        completionTokens: opts.usage.completionTokens,
        costUsd: opts.usage.costUsd,
        finishedAt: new Date(),
      },
    });
    return message;
  });
  // Postgres first, publish after: a dropped publish is healed by the next refetch.
  await publishUserEvent(
    opts.userId,
    "new_message",
    newMessagePayload(opts.conversationId, reply),
  ).catch((e) =>
    getLogger().error(
      { err: e, conversationId: opts.conversationId },
      "reply publish failed (reply already written)",
    ),
  );
  return reply.id;
}

interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  steps: number;
  toolCalls: number;
  model?: string;
}

async function runConversation(
  data: TurnJobData,
  content: string,
  runId: string,
  inputCreatedAt: Date,
  options: TurnOptions,
  assertOwned: () => Promise<void>,
): Promise<void> {
  const { conversationId, userId } = data;
  const log = getLogger().child({ conversationId, runId });
  const startedAt = Date.now();

  const [user, messageCount, rows, specs] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    }),
    prisma.message.count({ where: { conversationId } }),
    prisma.sessionEntry.findMany({
      where: { conversationId },
      orderBy: { seq: "asc" },
    }),
    (options.readTools ?? readToolsFor)(userId),
  ]);
  let facts: FactHit[] = [];
  if (messageCount >= HARNESS_FACTS_MIN_MESSAGES) {
    facts = await searchActiveFactsWithRelations(conversationId, content).catch(
      (e) => {
        log.warn({ err: e }, "fact retrieval failed; continuing without facts");
        return [];
      },
    );
  }

  const usage: RunUsage = {
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    steps: 0,
    toolCalls: 0,
  };
  const history =
    rows.length === 0
      ? (
          await prisma.message.findMany({
            where: { conversationId, createdAt: { lt: inputCreatedAt } },
            orderBy: { createdAt: "desc" },
            take: HARNESS_LEGACY_HISTORY_LIMIT,
          })
        ).reverse()
      : [];

  let session: AgentSession;
  try {
    session = await sessions.open(conversationId, {
      entries: rows.map((r) => r.data as unknown as SessionEntry),
      history,
      specs,
      ctx: { userId, conversationId },
      runtimeContext: () =>
        buildRuntimeContext({
          now: options.now?.() ?? new Date(),
          timezone: user?.timezone ?? null,
          facts,
        }),
    });
  } catch (e) {
    if (!(e instanceof ModelNotAvailableError)) throw e;
    log.error({ err: e }, "interaction model unavailable");
    await assertOwned();
    const replyId = await writeReply({
      conversationId,
      userId,
      runId,
      inputMessageId: data.messageId,
      content: UNAVAILABLE_REPLY,
      failed: true,
      usage,
      durationMs: 0,
    });
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        replyMessageId: replyId,
        error: { reason: "model_unavailable", message: e.message },
        finishedAt: new Date(),
      },
    });
    return;
  }

  // Persist every new pi entry, in order, as soon as pi records it.
  const persisted = new Set(rows.map((r) => r.entryId));
  let persistChain: Promise<void> = Promise.resolve();
  let persistError: unknown;
  const persistNew = () => {
    persistChain = persistChain
      .then(async () => {
        await assertOwned();
        const fresh = session.sessionManager
          .getEntries()
          .filter((e) => !persisted.has(e.id));
        if (fresh.length === 0) return;
        await prisma.sessionEntry.createMany({
          data: fresh.map((e) => ({
            conversationId,
            entryId: e.id,
            parentEntryId: e.parentId,
            type: e.type,
            data: e as unknown as InputJsonValue,
          })),
          skipDuplicates: true,
        });
        for (const e of fresh) persisted.add(e.id);
      })
      .catch((e) => {
        persistError = e;
        log.error({ err: e }, "session entry persist failed");
      });
  };

  let lastDeltaAt = 0;
  let lastStopReason: string | undefined;
  session.subscribe((event) => {
    if (
      event.type === "message_end" ||
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      persistChain = persistChain
        .then(async () => {
          await assertOwned();
          await prisma.agentStep.create({
            data: {
              runId,
              kind: event.type,
              data: JSON.parse(JSON.stringify(event)) as InputJsonValue,
            },
          });
        })
        .catch((e) => {
          persistError = e;
          log.error({ err: e }, "step journal persist failed");
        });
    }
    if (event.type === "message_update" && Date.now() - lastDeltaAt >= 100) {
      const text = assistantText(event.message);
      if (text) {
        lastDeltaAt = Date.now();
        void publishUserEvent(userId, "message_delta", {
          conversationId,
          inputMessageId: data.messageId,
          text,
        }).catch(() => {});
      }
    }
    if (event.type === "message_end") {
      persistNew();
      const m = event.message as {
        role?: string;
        model?: string;
        stopReason?: string;
        durationMs?: number;
        usage?: {
          input?: number;
          output?: number;
          cacheRead?: number;
          totalTokens?: number;
          cost?: { total?: number };
        };
      };
      if (m.role === "assistant") {
        lastStopReason = m.stopReason;
        usage.steps += 1;
        usage.model = m.model;
        usage.promptTokens += m.usage?.input ?? 0;
        usage.completionTokens += m.usage?.output ?? 0;
        usage.costUsd += m.usage?.cost?.total ?? 0;
        void trackModelCall({
          userId,
          useCase: "interaction",
          result: {
            content: "",
            model: m.model ?? "unknown",
            latencyMs: m.durationMs ?? 0,
            usage: {
              promptTokens: m.usage?.input ?? 0,
              completionTokens: m.usage?.output ?? 0,
              totalTokens: m.usage?.totalTokens ?? 0,
            },
            cachedTokens: m.usage?.cacheRead,
            finishReason: m.stopReason,
          },
          costCents: Math.round((m.usage?.cost?.total ?? 0) * 100),
        });
      }
    } else if (event.type === "tool_execution_end") {
      usage.toolCalls += 1;
    }
  });

  const fromIndex = session.messages.length;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    log.warn("run timed out; aborting");
    void session.abort();
  }, HARNESS_TURN_TIMEOUT_MS);

  let runError: unknown;
  try {
    await assertOwned();
    await session.prompt(content);
    await session.waitForIdle();
  } catch (e) {
    runError = e;
    log.error({ err: e }, "harness run failed");
  } finally {
    clearTimeout(timer);
  }
  persistNew();
  await persistChain;
  await assertOwned();
  if (persistError) throw persistError;

  const replies = repliesByInput(session.messages, fromIndex, 1);
  const durationMs = Date.now() - startedAt;

  const text = replies[0] ?? "";
  const failed =
    !text ||
    text === "NO_REPLY" ||
    timedOut ||
    runError !== undefined ||
    lastStopReason === "error" ||
    lastStopReason === "aborted";
  const replyId = await writeReply({
    conversationId,
    userId,
    runId,
    inputMessageId: data.messageId,
    content: failed ? FALLBACK_REPLY : text,
    failed,
    model: usage.model,
    usage,
    durationMs,
  });
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: failed ? "failed" : "succeeded",
      replyMessageId: replyId,
      model: usage.model,
      finishedAt: new Date(),
      steps: usage.steps,
      toolCalls: usage.toolCalls,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: usage.costUsd,
      error: failed
        ? {
            reason: runError ? "run_error" : "empty_reply",
            message: runError instanceof Error ? runError.message : undefined,
          }
        : undefined,
    },
  });

  await rollDailyUsage(userId, usage.promptTokens + usage.completionTokens);
  await trackEvent(userId, "chat_message_reply", {
    conversationId,
    model: usage.model,
    steps: usage.steps,
    toolCalls: usage.toolCalls,
    totalTokens: usage.promptTokens + usage.completionTokens,
    latencyMs: durationMs,
  });
  log.info({ ...usage, durationMs }, "harness run settled");
  await publishUserEvent(userId, "turn_settled", {
    conversationId,
    inputMessageId: data.messageId,
  }).catch(() => {});

  // Fact extraction runs after the reply, off the request path, once a thread
  // is long enough for remembered facts to matter.
  if (messageCount >= HARNESS_FACTS_MIN_MESSAGES) {
    await prisma.outboxEvent
      .create({
        data: {
          eventType: "extract_facts",
          payload: {
            conversationId,
            userId,
            windowEnd: new Date().toISOString(),
          },
        },
      })
      .catch((e) =>
        log.error({ err: e }, "failed to enqueue extract_facts outbox row"),
      );
  }
}

export async function runTurn(
  data: TurnJobData,
  options: TurnOptions = {},
): Promise<void> {
  const log = getLogger().child({
    conversationId: data.conversationId,
    messageId: data.messageId,
  });
  const input = await prisma.message.findFirst({
    where: {
      id: data.messageId,
      conversationId: data.conversationId,
      conversation: { userId: data.userId },
      role: "user",
    },
  });
  if (!input) {
    log.warn("turn job points at a missing or non-user message; dropping");
    return;
  }
  const existing = await prisma.agentRun.findUnique({
    where: { inputMessageId: data.messageId },
  });
  if (existing?.status === "succeeded" || existing?.replyMessageId) {
    log.info({ runId: existing.id }, "turn already answered; skipping");
    return;
  }

  const token = await acquireLock(data.conversationId);
  if (!token) throw new ConversationBusyError(data.conversationId);
  let lost = false;
  const loseOwnership = () => {
    lost = true;
    void sessions
      .abort(data.conversationId)
      .catch((error) =>
        log.error({ err: error }, "failed to abort run after lock loss"),
      );
  };
  const assertOwned = async () => {
    if (lost || (await redis.get(lockKey(data.conversationId))) !== token) {
      loseOwnership();
      throw new ConversationBusyError(data.conversationId);
    }
  };
  const heartbeat = setInterval(
    () => {
      void redis
        .eval(
          RENEW_LUA,
          1,
          lockKey(data.conversationId),
          token,
          HARNESS_LOCK_TTL_MS,
        )
        .then((renewed) => {
          if (renewed !== 1) loseOwnership();
        })
        .catch((error) => {
          log.error({ err: error }, "conversation lock renewal failed");
          loseOwnership();
        });
    },
    Math.floor(HARNESS_LOCK_TTL_MS / 3),
  );
  try {
    // Another job may have answered while this attempt was acquiring the lock.
    const answered = await prisma.agentRun.findUnique({
      where: { inputMessageId: data.messageId },
    });
    if (answered?.replyMessageId) return;
    const runId = await startRun(data);
    await runConversation(
      data,
      input.content,
      runId,
      input.createdAt,
      options,
      assertOwned,
    );
  } finally {
    sessions.evict(data.conversationId);
    clearInterval(heartbeat);
    await releaseLock(data.conversationId, token);
  }
}

export function createTurnProcessor(options: TurnOptions = {}) {
  return async function processTurn(job: Job, token?: string): Promise<void> {
    try {
      await runTurn(job.data as TurnJobData, options);
    } catch (error) {
      if (!(error instanceof ConversationBusyError)) throw error;
      await job.moveToDelayed(Date.now() + 1000, token);
      throw new DelayedError();
    }
  };
}

export const turnProcessor = createTurnProcessor();
