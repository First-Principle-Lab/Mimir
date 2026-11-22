import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Queue, QueueEvents, Worker } from "bullmq";
import express from "express";
import { Redis } from "ioredis";
import { io } from "socket.io-client";
import { loadEnv } from "./_env.js";
import { appendRow, newRunId } from "./eval/lib.js";

loadEnv();
if (!process.env.OPENROUTER_API_KEY) {
  console.error("GATE NOT RUN: OPENROUTER_API_KEY missing");
  process.exit(2);
}
for (const name of ["DATABASE_URL", "REDIS_URL"] as const)
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(process.env[name] ?? "http://missing").hostname,
    )
  ) {
    console.error(`GATE NOT RUN: ${name} must point to local eval services`);
    process.exit(2);
  }
const { getConfig, getPrismaClient, postInbox } =
  await import("../packages/backend-core/src/index.js");
const { createMessageRouter } =
  await import("../apps/api/src/routes/message.js");
const { initSocket, initPubSub } =
  await import("../apps/api/src/infra/socket.js");
const { drainDeliveries, acknowledgeDelivery } =
  await import("../apps/api/src/infra/delivery-queue.js");
const { signAccessToken } = await import("../apps/api/src/auth/tokens.js");
const { createTurnProcessor } =
  await import("../apps/worker/src/harness/turn.js");
const { readToolsFor } = await import("../apps/worker/src/harness/tools.js");
const { interactionModelId } =
  await import("../apps/worker/src/harness/pi-runtime.js");
const { runRoutine, syncRoutine } =
  await import("../apps/worker/src/routines/routines.js");
const { GMAIL_INTEGRATION } =
  await import("../packages/connection-provider/src/index.js");
const prisma = getPrismaClient();
const connection = { url: getConfig().REDIS_URL, maxRetriesPerRequest: null };
const queue = new Queue(`inbox-eval-${randomUUID()}`, { connection });
const routineQueue = new Queue(`inbox-routines-eval-${randomUUID()}`, {
  connection,
});
const events = new QueueEvents(queue.name, { connection });
const subscriber = new Redis(connection.url);
const runId = newRunId();
const users: string[] = [];
const conversations: string[] = [];
const gates = new Map<string, { entered: () => void; held: Promise<void> }>();
const syntheticTools: typeof readToolsFor = async (userId) =>
  (await readToolsFor(userId)).map((spec) => ({
    ...spec,
    execute: async () => {
      if (spec.name === "search_email") {
        const gate = gates.get(userId);
        if (gate) {
          gate.entered();
          await gate.held;
        }
        return {
          messages: [
            {
              id: "invoice-1",
              subject: "Quarterly invoice",
              body: "Amount USD 120, due 30 November 2026.",
            },
          ],
        };
      }
      return { facts: [] };
    },
  }));
const worker = new Worker(
  queue.name,
  createTurnProcessor({ readTools: syntheticTools }),
  { connection, concurrency: 8 },
);
const app = express();
app.use(express.json());
app.use(
  "/api/v1",
  createMessageRouter(async (input) => {
    await queue.add("turn", input, {
      jobId: `turn-${input.messageId}`,
      attempts: 1,
    });
    return true;
  }),
);
const server = createServer(app);
initSocket(server);
initPubSub(subscriber);
const routineWorker = new Worker(
  routineQueue.name,
  (job) => runRoutine(job, syntheticTools),
  { connection },
);
const clients: ReturnType<typeof io>[] = [];
let passed = 0;
let tp = 0,
  fp = 0,
  fn = 0;
async function waitUntil(
  check: () => boolean | Promise<boolean>,
  label: string,
  ms = 10000,
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(25);
  }
}
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

const cases = [
  "message-burst",
  "mid-task-correction",
  "stop",
  "nothing-new-result",
  "misfired-trigger",
  "relevant-worker-result",
  "watcher-match",
  "requested-reminder",
  "quiet-hours",
  "digest",
  "schedule-end-to-end",
] as const;
try {
  await events.waitUntilReady();
  await worker.waitUntilReady();
  await routineWorker.waitUntilReady();
  await subscriber.psubscribe("user-events:*");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const name of cases) {
    const userId = `inbox-eval-${randomUUID()}`;
    users.push(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        passwordHash: "synthetic",
        timezone: "Asia/Kolkata",
      },
    });
    const c = await prisma.conversation.create({ data: { userId } });
    conversations.push(c.id);
    await prisma.integrationConnection.create({
      data: {
        userId,
        provider: GMAIL_INTEGRATION,
        connectionId: `synthetic-${randomUUID()}`,
        status: "connected",
      },
    });
    const cookie = `access_token=${await signAccessToken(userId, getConfig().JWT_SECRET)}`;
    const client = io(base, {
      extraHeaders: { cookie },
      transports: ["websocket"],
      reconnection: false,
    });
    clients.push(client);
    const received: { event: string; payload: Record<string, unknown> }[] = [];
    client.onAny((event, payload) => {
      received.push({ event, payload });
      if (payload?.deliveryIds)
        client.emit("delivery_ack", payload.deliveryIds);
    });
    const failures: string[] = [];
    let evidence: Record<string, unknown> = {};
    let release = () => {};
    const submit = async (content: string) => {
      const response = await fetch(`${base}/api/v1/message`, {
        method: "POST",
        headers: { cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: c.id,
          content,
          clientMessageId: randomUUID(),
        }),
      });
      requireThat(
        response.status === 202,
        `Intake returned ${response.status}`,
      );
      const result = (await response.json()) as { message: { id: string } };
      const job = await queue.getJob(`turn-${result.message.id}`);
      requireThat(job, "Missing queue job");
      return { id: result.message.id, job };
    };
    const ambient = async (
      kind: "agent_result" | "routine_fire" | "event",
      text: string,
    ) => {
      let inputId: string;
      if (kind === "agent_result")
        inputId = await postInbox({
          conversationId: c.id,
          userId,
          source: "worker:synthetic",
          dedupeKey: name,
          payload: {
            kind,
            agentRunId: "synthetic-child",
            status: "succeeded",
            text,
          },
        });
      else {
        const routine = await prisma.routine.create({
          data: {
            conversationId: c.id,
            userId,
            instruction: text,
            source: kind === "event" ? "gmail" : "schedule",
            query:
              kind === "event"
                ? { tool: "search_email", args: { query: "subject:invoice" } }
                : {},
            timing: {
              type: "once",
              at: new Date(Date.now() - 1000).toISOString(),
            },
          },
        });
        await runRoutine(
          { data: { routineId: routine.id }, id: name, timestamp: Date.now() },
          syntheticTools,
        );
        inputId = (
          await prisma.inboxInput.findFirstOrThrow({
            where: { conversationId: c.id },
          })
        ).id;
      }
      const job = await queue.add(
        "turn",
        { conversationId: c.id, userId, inputId },
        { attempts: 1 },
      );
      await job.waitUntilFinished(events, 150000);
      return prisma.agentRun.findUniqueOrThrow({
        where: { inboxInputId: inputId },
      });
    };
    try {
      await waitUntil(() => client.connected, "socket connection");
      if (name === "message-burst") {
        const a = await submit("What is 2 + 2?");
        await Bun.sleep(100);
        const b = await submit("Also, what is 3 + 3? Answer both questions.");
        await Promise.all([
          a.job.waitUntilFinished(events, 150000),
          b.job.waitUntilFinished(events, 150000),
        ]);
        const answers = await prisma.message.findMany({
          where: { conversationId: c.id, role: "assistant" },
        });
        requireThat(
          answers.length === 1 &&
            answers[0]!.replyToMessageIds.includes(a.id) &&
            answers[0]!.replyToMessageIds.includes(b.id),
          "Burst was not covered by one reply",
        );
        requireThat(
          answers[0]!.content.includes("4") &&
            answers[0]!.content.includes("6"),
          "Burst answer omitted a question",
        );
      } else if (name === "mid-task-correction" || name === "stop") {
        let enter = () => {};
        const entered = new Promise<void>((r) => {
          enter = r;
        });
        const held = new Promise<void>((r) => {
          release = r;
        });
        gates.set(userId, { entered: enter, held });
        const a = await submit(
          "Search my latest invoice email and tell me its amount.",
        );
        await Promise.race([
          entered,
          Bun.sleep(60000).then(() => {
            throw new Error("Model did not search email");
          }),
        ]);
        const b = await submit(
          name === "stop"
            ? "stop"
            : "Correction: report ONLY the due date, not the amount.",
        );
        await Bun.sleep(1300);
        release();
        await Promise.all([
          a.job.waitUntilFinished(events, 150000),
          b.job.waitUntilFinished(events, 150000),
        ]);
        const answer = await prisma.message.findFirstOrThrow({
          where: { conversationId: c.id, role: "assistant" },
        });
        requireThat(
          answer.replyToMessageIds.includes(b.id),
          "Mid-task input was lost",
        );
        requireThat(
          name === "stop"
            ? answer.content === "Stopped."
            : answer.content.includes("30") && !answer.content.includes("120"),
          "Correction/stop was not honored",
        );
      } else if (name === "schedule-end-to-end") {
        const at = new Date(Date.now() + 20000).toISOString();
        const input = await submit(
          `Set a one-time reminder at exactly ${at} to stretch. Use that exact timestamp.`,
        );
        await input.job.waitUntilFinished(events, 150000);
        const routine = await prisma.routine.findFirstOrThrow({
          where: { conversationId: c.id },
        });
        requireThat(
          routine.source === "schedule" && routine.status === "active",
          "Model did not store a schedule",
        );
        await syncRoutine(routine.id, routineQueue);
        await waitUntil(
          async () =>
            !!(await prisma.inboxInput.findFirst({
              where: { conversationId: c.id, kind: "routine_fire" },
            })),
          "scheduled BullMQ fire",
          40000,
        );
        const fire = await prisma.inboxInput.findFirstOrThrow({
          where: { conversationId: c.id, kind: "routine_fire" },
        });
        const job = await queue.add("turn", {
          conversationId: c.id,
          userId,
          inputId: fire.id,
        });
        await job.waitUntilFinished(events, 150000);
        requireThat(
          (await prisma.delivery.count({
            where: { conversationId: c.id, ambient: true },
          })) === 1,
          "Scheduled fire did not produce exactly one notification",
        );
      } else {
        const negative =
          name === "nothing-new-result" || name === "misfired-trigger";
        if (name === "quiet-hours")
          await prisma.user.update({
            where: { id: userId },
            data: {
              timezone: "UTC",
              notificationPreferences: {
                quietEnabled: true,
                quietStart: 1320,
                quietEnd: 480,
              },
            },
          });
        const text =
          name === "nothing-new-result"
            ? "Monitor result: no changes since the last update, nothing new to report. The user did not ask for status."
            : name === "misfired-trigger"
              ? "Watch for new URGENT bills only. This is a spurious timer wake; there are NO new bills or account changes. Do not notify merely to acknowledge this wake."
              : name === "relevant-worker-result"
                ? "The user requested a research result and asked to be notified when done. Task succeeded: the confirmed answer to the requested calculation is 42. This is the first completed result."
                : name === "watcher-match"
                  ? "Tell me when a new invoice arrives and include its amount and due date. The matching message is new, not previously reported."
                  : name === "digest"
                    ? "Remind the user to stretch. This reminder is intentionally low priority; use low urgency so it joins a digest."
                    : "Remind the user to stretch now; this is their explicitly requested reminder. Normal urgency.";
        if (name === "relevant-worker-result")
          await prisma.message.createMany({
            data: [
              {
                conversationId: c.id,
                role: "user",
                content:
                  "Please calculate the answer to 6 times 7 and notify me when the calculation is complete.",
                createdAt: new Date(Date.now() - 2000),
              },
              {
                conversationId: c.id,
                role: "assistant",
                content: "The calculation is in progress.",
                createdAt: new Date(Date.now() - 1000),
              },
            ],
          });
        const run = await ambient(
          name === "nothing-new-result" || name === "relevant-worker-result"
            ? "agent_result"
            : name === "watcher-match"
              ? "event"
              : "routine_fire",
          text,
        );
        const notifications = await prisma.delivery.findMany({
          where: { conversationId: c.id, ambient: true },
        });
        if (negative) {
          if (notifications.length) fp++;
          requireThat(
            !notifications.length,
            "Unnecessary ambient notification",
          );
        } else {
          if (notifications.length) tp++;
          else fn++;
          requireThat(
            notifications.length === 1,
            "Wrongly silent requested reminder",
          );
        }
        requireThat(run.status === "succeeded", `Ambient run ${run.status}`);
        requireThat(
          !received.some((e) => e.event === "message_delta"),
          "Ambient text escaped through streaming",
        );
        if (name === "quiet-hours") {
          await prisma.delivery.updateMany({
            where: { conversationId: c.id },
            data: {
              createdAt: new Date("2026-11-22T21:30:00Z"),
              availableAt: new Date("2026-11-22T21:30:00Z"),
            },
          });
          let emitted = 0;
          await drainDeliveries({
            userId,
            now: new Date("2026-11-22T23:00:00Z"),
            emit: () => {
              emitted++;
              return 1;
            },
            push: async () => 0,
          });
          requireThat(emitted === 0, "Quiet hours leaked a notification");
          await drainDeliveries({
            userId,
            now: new Date("2026-11-23T08:00:00Z"),
            emit: () => {
              emitted++;
              return 1;
            },
            push: async () => 0,
          });
          requireThat(
            Number(emitted) === 1,
            "Quiet-hours notification was not released",
          );
          await acknowledgeDelivery(
            userId,
            notifications.map((n) => n.id),
          );
        }
        if (name === "digest") {
          requireThat(
            notifications[0]!.urgency === "low",
            "Model did not select low urgency",
          );
          let emitted = 0;
          await drainDeliveries({
            userId,
            now: new Date(Date.now() + 3600_000),
            emit: () => {
              emitted++;
              return 1;
            },
            push: async () => 0,
          });
          requireThat(emitted === 1, "Digest was not released");
          await acknowledgeDelivery(
            userId,
            notifications.map((n) => n.id),
          );
        }
      }
      const runs = await prisma.agentRun.findMany({
        where: { conversationId: c.id },
      });
      requireThat(
        runs.some((r) => r.promptTokens > 0 && r.completionTokens > 0),
        "No actual model inference was recorded",
      );
      requireThat(
        (await prisma.inboxInput.count({
          where: { conversationId: c.id, status: { not: "consumed" } },
        })) === 0,
        "An input was stranded",
      );
      evidence = {
        runs: runs.map((r) => ({
          status: r.status,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
        })),
        inbox: await prisma.inboxInput.count({
          where: { conversationId: c.id },
        }),
        deliveries: await prisma.delivery.count({
          where: { conversationId: c.id },
        }),
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    } finally {
      release();
      gates.delete(userId);
      client.close();
    }
    if (!failures.length) passed++;
    appendRow("harness", runId, {
      scenario: name,
      group: "phase-2-inbox",
      model: interactionModelId(),
      mode: "live-model-http-bullmq-postgres-socket-synthetic-accounts",
      evidence,
      failures,
      passed: !failures.length,
    });
    console.log(
      `${failures.length ? "FAIL" : "PASS"} ${name}${failures.length ? `: ${failures.join("; ")}` : ""}`,
    );
  }
} finally {
  for (const client of clients) client.close();
  await worker.close();
  await routineWorker.close();
  await events.close();
  for (const q of [queue, routineQueue]) {
    await q.obliterate({ force: true });
    await q.close();
  }
  await subscriber.quit();
  server.close();
  for (const conversationId of conversations) {
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ["conversationId"], equals: conversationId } },
    });
    const ids = (
      await prisma.routine.findMany({
        where: { conversationId },
        select: { id: true },
      })
    ).map((r) => r.id);
    for (const id of ids)
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ["routineId"], equals: id } },
      });
    await prisma.message.deleteMany({ where: { conversationId } });
  }
  for (const userId of users)
    await prisma.outboxEvent.deleteMany({
      where: { payload: { path: ["userId"], equals: userId } },
    });
  await prisma.conversation.deleteMany({
    where: { id: { in: conversations } },
  });
  const userFilter = { userId: { in: users } };
  await prisma.integrationConnection.deleteMany({ where: userFilter });
  await prisma.modelCallLog.deleteMany({ where: userFilter });
  await prisma.analyticsEvent.deleteMany({ where: userFilter });
  await prisma.usageRecord.deleteMany({ where: userFilter });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}
const precision = tp / Math.max(1, tp + fp),
  recall = tp / Math.max(1, tp + fn);
console.log(
  `Inbox: ${passed}/${cases.length}; notification precision ${precision}, recall ${recall}, wrongly silent ${fn}. Targets: 1.0/1.0/0 on these fixtures.`,
);
process.exit(
  passed === cases.length && precision === 1 && recall === 1 && fn === 0
    ? 0
    : 1,
);
