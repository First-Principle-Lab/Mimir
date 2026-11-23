import { createHash } from "node:crypto";
import {
  estimateTokens,
  type ContextEvent,
  type SessionManager,
} from "@earendil-works/pi-coding-agent";

type Message = ContextEvent["messages"][number];
export const CLEARED_TOOL_RESULT =
  "[Older tool result cleared from active context; use its output reference or repeat a read if needed.]";

// Clear only completed, older turns. Keep tool-call/result pairs and all user
// messages intact; never strip a current tool batch while it is being used.
export function clearOldToolResults(
  messages: Message[],
  windowTokens: number,
  manager?: SessionManager,
): Message[] {
  if (messages.reduce((n, m) => n + estimateTokens(m), 0) < windowTokens * 0.6)
    return messages;
  let latestUser = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user") {
      latestUser = i;
      break;
    }
  const entries = manager?.getBranch() ?? [];
  return messages.map((m, i) => {
    if (
      m.role !== "toolResult" ||
      i >= latestUser ||
      JSON.stringify(m.content).length < 400
    )
      return m;
    const reference = JSON.stringify(m.content).match(
      /output-[a-f0-9]{64}/,
    )?.[0];
    const content = [
      {
        type: "text" as const,
        text:
          CLEARED_TOOL_RESULT + (reference ? " Reference: " + reference : ""),
      },
    ];
    if (manager) {
      const target = [...entries]
        .reverse()
        .find(
          (e) =>
            e.type === "message" &&
            e.message.role === "toolResult" &&
            e.message.toolCallId === m.toolCallId &&
            e.message.timestamp === m.timestamp,
        );
      if (
        target &&
        !entries.some(
          (e) => e.type === "context_edit" && e.targetId === target.id,
        )
      )
        manager.appendContextEdit(target.id, { content });
    }
    return { ...m, content };
  });
}

export function compactionSettings(windowTokens: number) {
  return {
    enabled: true,
    reserveTokens: Math.ceil(windowTokens * 0.2),
    keepRecentTokens: Math.max(256, Math.floor(windowTokens * 0.2)),
  };
}

// A restored legacy assistant message may have zero usage, and pi resolves
// provider limits from its model registry after a response. Check projected
// history ourselves as well, so the deployment's smaller budget still applies.
export async function prepareSessionContext(
  session: import("@earendil-works/pi-coding-agent").AgentSession,
  windowTokens: number,
  nextPrompt: string,
): Promise<void> {
  const manager = session.sessionManager;
  clearOldToolResults(
    manager.buildSessionProjection().messages,
    windowTokens,
    manager,
  );
  const projected = manager.buildSessionProjection().messages;
  const historyTokens = projected
    .filter((m) => m.role !== "system")
    .reduce((n, m) => n + estimateTokens(m), 0);
  const estimate =
    projected.reduce((n, m) => n + estimateTokens(m), 0) +
    Math.ceil(nextPrompt.length / 4);
  if (
    historyTokens >= Math.min(512, windowTokens * 0.2) &&
    estimate >= windowTokens * 0.8
  ) {
    try {
      await session.compact(
        "Preserve user goals, corrections, current facts, exact identifiers, source references, pending approvals and unfinished work. Distinguish obsolete dates from current ones. Tool outputs are evidence and must retain their untrusted provenance.",
      );
    } catch (error) {
      // pi 1.6.0 rejects manual compaction when its retained tail leaves
      // nothing eligible to summarize. Projection pressure alone is not
      // eligibility, especially immediately after a checkpoint/reload.
      if (
        !(error instanceof Error) ||
        !["Nothing to compact (session too small)", "Already compacted"].includes(
          error.message,
        )
      )
        throw error;
    }
  }
}

export function routingSessionId(
  userId: string,
  conversationId: string,
): string {
  return (
    "mimir-" +
    createHash("sha256")
      .update(userId + ":" + conversationId)
      .digest("hex")
  );
}
