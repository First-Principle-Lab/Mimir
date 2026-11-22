import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  burstReadyAt,
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
import { publishUserEvent, redis } from "../infra/redis.js";
import { buildRuntimeContext } from "./context.js";
import { ModelNotAvailableError } from "./pi-runtime.js";
import { SessionHost } from "./session-host.js";
import { readToolsFor } from "./tools.js";
import {
  claimInputs,
  inputText,
  isStop,
  payloadOf,
  pendingInputs,
  type Input,
} from "./inbox.js";
import { responseTools } from "./response-tools.js";

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
  messageId?: string;
  inputId?: string;
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

async function startRun(data: TurnJobData, input: Input): Promise<string> {
  const run = await prisma.agentRun.upsert({
    where: { inboxInputId: input.id },
    create: {
      conversationId: data.conversationId,
      userId: data.userId,
      trigger: input.kind,
      inboxInputId: input.id,
      inputMessageId: input.messageId,
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
  inputMessageId?: string;
  inputs: Input[];
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
        replyToMessageIds: opts.inputs.flatMap((i) =>
          i.messageId ? [i.messageId] : [],
        ),
        errorDetail: opts.failed ? { reason: "no_reply" } : undefined,
      },
    });
    await tx.inboxInput.updateMany({
      where: { id: { in: opts.inputs.map((i) => i.id) } },
      data: {
        status: "consumed",
        consumedAt: new Date(),
        replyMessageId: message.id,
      },
    });
    await tx.delivery.create({
      data: {
        conversationId: opts.conversationId,
        userId: opts.userId,
        messageId: message.id,
        urgency: "normal",
        reasonCode: "user_reply",
        ambient: false,
      },
    });
    await tx.outboxEvent.create({
      data: { eventType: "delivery_ready", payload: { userId: opts.userId } },
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
  await publishUserEvent(opts.userId, "delivery_ready", {}).catch((e) =>
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
  inputs: Input[],
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

  const response = { sent: false, interrupted: false };
  const ambient = !inputs.some((i) => i.kind === "user");
  specs.push(
    ...responseTools({
      userId,
      conversationId,
      runId,
      inputs,
      ambient,
      response,
      assertOwned,
    }),
  );
  let session: AgentSession;
  try {
    session = await sessions.open(conversationId, {
      entries: rows.map((r) => r.data as unknown as SessionEntry),
      history,
      specs,
      ctx: { userId, conversationId, runId },
      runtimeContext: () =>
        buildRuntimeContext({
          now: options.now?.() ?? new Date(),
          timezone: user?.timezone ?? null,
          facts,
        }) +
        `\n<response_contract>Mode: ${ambient ? "ambient" : "chat"}. ${ambient ? "No user reply is owed. Speak only with send_to_user(text, urgency, reason_code). For nothing new or relevant, finish with exactly NO_REPLY. Never deliver plain final text." : "A reply is owed to every user input in this turn, including corrections. Finish with a visible answer covering all inputs. NO_REPLY is forbidden."}</response_contract>`,
    });
  } catch (e) {
    if (!(e instanceof ModelNotAvailableError)) throw e;
    log.error({ err: e }, "interaction model unavailable");
    await assertOwned();
    if (ambient) throw e;
    const replyId = await writeReply({
      conversationId,
      userId,
      runId,
      inputMessageId: data.messageId,
      inputs,
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
    if (
      !ambient &&
      event.type === "message_update" &&
      Date.now() - lastDeltaAt >= 100
    ) {
      const text = assistantText(event.message);
      if (text && !"NO_REPLY".startsWith(text)) {
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

  // Polling the durable inbox works across processes; steering stays in the
  // owning pi session and is applied by pi after the current tool batch.
  let pumping: Promise<void> = Promise.resolve();
  let pumpError: unknown;
  const pump = () => {
    pumping = pumping
      .then(async () => {
        await assertOwned();
        const fresh = (await pendingInputs(conversationId)).filter(
          (i) => i.kind === "user" && !inputs.some((old) => old.id === i.id),
        );
        if (!fresh.length || !session.isStreaming) return;
        if (ambient) {
          response.interrupted = true;
          await session.abort();
          return;
        }
        if (fresh.some(isStop)) {
          await claimInputs(fresh, runId);
          inputs.push(...fresh);
          response.interrupted = true;
          await session.abort();
          return;
        }
        if (
          Date.now() <
          burstReadyAt(fresh[0]!.createdAt, fresh.at(-1)!.createdAt)
        )
          return;
        await claimInputs(fresh, runId);
        await session.steer(inputText(fresh));
        inputs.push(...fresh);
      })
      .catch((e) => {
        pumpError = e;
        void session.abort();
      });
  };
  const inboxTimer = setInterval(pump, 100);
  let runError: unknown;
  try {
    await assertOwned();
    await session.prompt(content);
    await session.waitForIdle();
    await pumping;
    if (pumpError) throw pumpError;
    const latestText = () =>
      assistantText(
        [...session.messages.slice(fromIndex)]
          .reverse()
          .find((m) => (m as { role?: string }).role === "assistant"),
      );
    let text = latestText();
    if (
      !response.interrupted &&
      !response.sent &&
      (!text || (!ambient && text === "NO_REPLY"))
    ) {
      await session.prompt(
        ambient
          ? "The last turn was empty. Finish with exactly NO_REPLY when there is nothing to report, or call send_to_user for a warranted notification."
          : "A user reply is still owed. Give the answer now, or clearly state the blocker. NO_REPLY is not allowed.",
      );
      await session.waitForIdle();
      text = latestText();
    }
    if (
      ambient &&
      !response.sent &&
      text &&
      text !== "NO_REPLY" &&
      !response.interrupted
    ) {
      await session.prompt(
        "Your text has not been delivered. Call send_to_user if a notification is warranted, otherwise finish with exactly NO_REPLY. This is the only delivery nudge.",
      );
      await session.waitForIdle();
    }
  } catch (e) {
    runError = e;
    log.error({ err: e }, "harness run failed");
  } finally {
    clearInterval(inboxTimer);
    await pumping;
    clearTimeout(timer);
  }
  persistNew();
  await persistChain;
  await assertOwned();
  if (persistError) throw persistError;

  const durationMs = Date.now() - startedAt;

  const text = [...session.messages.slice(fromIndex)]
    .reverse()
    .find((m) => (m as { role?: string }).role === "assistant");
  const finalText = assistantText(text);
  const failed =
    !response.interrupted &&
    (!finalText ||
      (!response.sent && finalText === "NO_REPLY" && !ambient) ||
      (ambient && !response.sent && finalText !== "NO_REPLY") ||
      timedOut ||
      runError !== undefined ||
      lastStopReason === "error" ||
      lastStopReason === "aborted");
  const replyId = ambient
    ? undefined
    : await writeReply({
        conversationId,
        userId,
        runId,
        inputMessageId: data.messageId,
        inputs,
        content: response.interrupted
          ? "Stopped."
          : failed
            ? FALLBACK_REPLY
            : finalText,
        failed,
        model: usage.model,
        usage,
        durationMs,
      });
  await prisma.agentRun.update({
    where: { id: runId },
    data: {
      status: response.interrupted
        ? "interrupted"
        : failed
          ? "failed"
          : "succeeded",
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

  if (ambient)
    await prisma.inboxInput.updateMany({
      where: { id: { in: inputs.map((i) => i.id) } },
      data: { status: "consumed", consumedAt: new Date() },
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
  for (const input of inputs)
    await publishUserEvent(userId, "turn_settled", {
      conversationId,
      inputMessageId: input.messageId ?? undefined,
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
  const owner = await prisma.conversation.findFirst({
    where: { id: data.conversationId, userId: data.userId },
  });
  if (!owner) return;
  // Compatibility with retained/retried Phase One queue jobs and direct tests.
  if (data.messageId) {
    const message = await prisma.message.findFirst({
      where: {
        id: data.messageId,
        conversationId: data.conversationId,
        role: "user",
      },
    });
    if (!message) return;
    await prisma.inboxInput.upsert({
      where: { messageId: message.id },
      create: {
        conversationId: data.conversationId,
        messageId: message.id,
        kind: "user",
        source: "user:legacy-queue",
        dedupeKey: `user:${message.id}`,
        payload: { kind: "user", text: message.content },
      },
      update: {},
    });
    const done = await prisma.inboxInput.findUnique({
      where: { messageId: message.id },
    });
    // Preserve Phase One replay/crash behavior when a retained job predates the
    // inbox migration. Its run is keyed by messageId and must not be recreated.
    const legacy = await prisma.agentRun.findUnique({
      where: { inputMessageId: message.id },
    });
    if (legacy && !legacy.inboxInputId)
      await prisma.agentRun.updateMany({
        where: { id: legacy.id, inboxInputId: null },
        data: { inboxInputId: done!.id },
      });
    if (legacy?.replyMessageId) {
      await prisma.inboxInput.update({
        where: { id: done!.id },
        data: {
          status: "consumed",
          runId: legacy.id,
          replyMessageId: legacy.replyMessageId,
          consumedAt: new Date(),
        },
      });
      return;
    }
    if (done?.status === "consumed") return;
  } else if (data.inputId) {
    const input = await prisma.inboxInput.findFirst({
      where: { id: data.inputId, conversationId: data.conversationId },
    });
    if (!input || input.status === "consumed") return;
  } else return;

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
  let activeRunId: string | undefined;
  let activeBatch: Input[] = [];
  try {
    const inputs: Input[] = [];
    for (const input of await pendingInputs(data.conversationId)) {
      const p = payloadOf(input);
      if (
        (p.kind === "event" || p.kind === "routine_fire") &&
        !(await prisma.routine.findFirst({
          where: {
            id: p.routineId,
            conversationId: data.conversationId,
            userId: data.userId,
            status: "active",
          },
        }))
      ) {
        await prisma.inboxInput.update({
          where: { id: input.id },
          data: { status: "consumed", consumedAt: new Date() },
        });
      } else inputs.push(input);
    }
    if (!inputs.length) return;
    // Ambient work waits when a user turn exists; user text is never hidden in
    // an ambient contract. Pending background inputs keep their own queue jobs.
    const users = inputs.filter((i) => i.kind === "user");
    const batch = users.length ? users : inputs;
    const first = batch[0]!;
    const runId = await startRun(
      { ...data, messageId: first.messageId ?? undefined },
      first,
    );
    activeRunId = runId;
    activeBatch = batch;
    await claimInputs(batch, runId);
    if (batch.some(isStop)) {
      await assertOwned();
      await writeReply({
        conversationId: data.conversationId,
        userId: data.userId,
        inputMessageId: first.messageId ?? undefined,
        inputs: batch,
        runId,
        content: "Stopped.",
        failed: false,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          steps: 0,
          toolCalls: 0,
        },
        durationMs: 0,
      });
      await prisma.agentRun.update({
        where: { id: runId },
        data: { status: "interrupted" },
      });
      for (const input of batch)
        await publishUserEvent(data.userId, "turn_settled", {
          conversationId: data.conversationId,
          inputMessageId: input.messageId,
        }).catch(() => {});
      return;
    }
    await runConversation(
      { ...data, messageId: first.messageId ?? undefined },
      inputText(batch),
      runId,
      first.createdAt,
      options,
      assertOwned,
      batch,
    );
  } catch (error) {
    if (error instanceof ConversationBusyError || !activeRunId) throw error;
    await assertOwned();
    const outstanding = await prisma.inboxInput.count({
      where: {
        id: { in: activeBatch.map((i) => i.id) },
        status: { not: "consumed" },
      },
    });
    if (!outstanding) throw error;
    log.error(
      { err: error, runId: activeRunId },
      "run setup/persistence failed; settling response contract",
    );
    if (activeBatch.some((i) => i.kind === "user"))
      await writeReply({
        conversationId: data.conversationId,
        userId: data.userId,
        inputMessageId: activeBatch[0]?.messageId ?? undefined,
        inputs: activeBatch,
        runId: activeRunId,
        content: FALLBACK_REPLY,
        failed: true,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          steps: 0,
          toolCalls: 0,
        },
        durationMs: 0,
      });
    else
      await prisma.$transaction(async (tx) => {
        await tx.agentRun.update({
          where: { id: activeRunId },
          data: {
            status: "failed",
            finishedAt: new Date(),
            error: { reason: "setup_or_persistence_failed" },
          },
        });
        await tx.inboxInput.updateMany({
          where: { id: { in: activeBatch.map((i) => i.id) } },
          data: { status: "consumed", consumedAt: new Date() },
        });
      });
  } finally {
    sessions.evict(data.conversationId);
    clearInterval(heartbeat);
    await releaseLock(data.conversationId, token);
    // A job may prioritize a user over the ambient input that woke it. Leave a
    // fresh wake for anything still pending; do not depend on the original
    // BullMQ job remaining around after it completes.
    const pending = await prisma.inboxInput.findFirst({
      where: { conversationId: data.conversationId, status: "pending" },
      orderBy: { seq: "asc" },
    });
    if (pending)
      await prisma.outboxEvent.create({
        data: {
          eventType: "conversation_turn",
          payload: {
            conversationId: data.conversationId,
            userId: data.userId,
            inputId: pending.id,
            wakeId: randomUUID(),
          },
        },
      });
  }
}

export function createTurnProcessor(options: TurnOptions = {}) {
  return async function processTurn(job: Job, token?: string): Promise<void> {
    try {
      const data = job.data as TurnJobData;
      const pending = await pendingInputs(data.conversationId);
      const waiting = pending.filter(
        (i) => i.kind === "user" && i.status === "pending",
      );
      if (waiting.length && !waiting.some(isStop)) {
        const readyAt = burstReadyAt(
          waiting[0]!.createdAt,
          waiting.at(-1)!.createdAt,
        );
        if (readyAt > Date.now()) {
          await job.moveToDelayed(readyAt, token);
          throw new DelayedError();
        }
      }
      await runTurn(data, options);
    } catch (error) {
      if (!(error instanceof ConversationBusyError)) throw error;
      await job.moveToDelayed(Date.now() + 1000, token);
      throw new DelayedError();
    }
  };
}

export const turnProcessor = createTurnProcessor();
