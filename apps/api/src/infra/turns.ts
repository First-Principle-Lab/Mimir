import { CONVERSATION_TURNS, getConfig, getLogger } from "@mimir/backend-core";
import { Queue } from "bullmq";

// Fast path for user turns: enqueue straight onto the worker's queue so a reply
// doesn't wait for the outbox relay's next poll. The OutboxEvent row written in
// the same transaction as the message is the crash-safe backstop; both use the
// same jobId, so whichever lands second is a BullMQ no-op.
let queue: Queue | null = null;

function turnsQueue(): Queue {
  if (!queue) {
    queue = new Queue(CONVERSATION_TURNS, {
      connection: { url: getConfig().REDIS_URL, maxRetriesPerRequest: 1 },
    });
    queue.on("error", (e) =>
      getLogger().warn({ err: e }, "turn queue redis error"),
    );
  }
  return queue;
}

export interface TurnInput {
  conversationId: string;
  userId: string;
  messageId: string;
}

export async function enqueueTurn(input: TurnInput): Promise<boolean> {
  try {
    await turnsQueue().add("turn", input, {
      jobId: `turn-${input.messageId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
    return true;
  } catch (e) {
    getLogger().warn(
      { err: e, messageId: input.messageId },
      "fast-path turn enqueue failed; the outbox relay will pick it up",
    );
    return false;
  }
}
