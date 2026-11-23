import { describe, expect, test } from "bun:test";
import {
  SessionManager,
  type ContextEvent,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  clearOldToolResults,
  compactionSettings,
  CLEARED_TOOL_RESULT,
  prepareSessionContext,
} from "../harness/context-policy.js";

type Message = ContextEvent["messages"][number];
const user = (text: string): Extract<Message, { role: "user" }> => ({
  role: "user",
  content: text,
  timestamp: 1,
});
const result = (
  id: string,
  content: string,
): Extract<Message, { role: "toolResult" }> => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "lookup",
  content: [{ type: "text", text: content }],
  isError: false,
  timestamp: 2,
});
describe("tiered context", () => {
  test("below threshold preserves original context and current tool batch", () => {
    const messages = [user("question"), result("current", "a".repeat(1000))];
    expect(clearOldToolResults(messages, 64000)).toBe(messages);
    expect(clearOldToolResults(messages, 100)).toEqual(messages);
  });
  test("clearing old results is durable, retains references and does not clear user text", () => {
    const manager = SessionManager.inMemory("/tmp");
    const reference = "output-" + "a".repeat(64);
    const messages = [
      user("remember this constraint"),
      result("old", reference + "x".repeat(3000)),
      user("new question"),
      result("new", "y".repeat(2000)),
    ];
    for (const m of messages) manager.appendMessage(m);
    const edited = clearOldToolResults(messages, 1000, manager);
    expect(JSON.stringify(edited[1])).toContain(CLEARED_TOOL_RESULT);
    expect(JSON.stringify(edited[1])).toContain(reference);
    expect(edited[0]).toBe(messages[0]);
    expect(edited[3]).toBe(messages[3]);
    expect(JSON.stringify(messages[1])).not.toContain(CLEARED_TOOL_RESULT);
    const hydrated = SessionManager.inMemory(
      "/tmp",
      undefined,
      manager.getEntries(),
    );
    expect(JSON.stringify(hydrated.buildSessionContext().messages)).toContain(
      CLEARED_TOOL_RESULT,
    );
    clearOldToolResults(messages, 1000, manager);
    expect(
      manager.getEntries().filter((e) => e.type === "context_edit"),
    ).toHaveLength(1);
  });
  test("summary starts at 80 percent and keeps 20 percent recent history", () => {
    expect(compactionSettings(64000)).toEqual({
      enabled: true,
      reserveTokens: 12800,
      keepRecentTokens: 12800,
    });
  });
  test.each(["Nothing to compact (session too small)", "Already compacted"])(
    "an ineligible native compaction preserves context: %s",
    async (message) => {
      const manager = SessionManager.inMemory("/tmp");
      manager.appendMessage(user("x".repeat(4000)));
      const before = manager.getEntries();
      let attempts = 0;
      await prepareSessionContext(
        {
          sessionManager: manager,
          compact: async () => {
            attempts++;
            throw new Error(message);
          },
        } as unknown as AgentSession,
        1000,
        "Continue",
      );
      expect(attempts).toBe(1);
      expect(manager.getEntries()).toEqual(before);
    },
  );
  test("unexpected compaction failures still propagate", async () => {
    const manager = SessionManager.inMemory("/tmp");
    manager.appendMessage(user("x".repeat(4000)));
    await expect(
      prepareSessionContext(
        {
          sessionManager: manager,
          compact: async () => {
            throw new Error("summary provider failed");
          },
        } as unknown as AgentSession,
        1000,
        "Continue",
      ),
    ).rejects.toThrow("summary provider failed");
  });
});
