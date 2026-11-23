import { executeJournaled } from "../../harness/actions.js";
import type { ToolSpec } from "../../harness/tools.js";
const [runId, userId, conversationId, url] = process.argv.slice(2) as [string, string, string, string];
const spec: ToolSpec = {
  name: "crash_send", label: "Crash send", description: "Synthetic crash fixture", parameters: {},
  risk: "communicate_external", sideEffect: "irreversible", idempotent: false, provenance: "test:crash", resultTrust: "untrusted", outputMaxChars: 1000,
  execute: async () => {
    await fetch(url, { method: "POST", body: "synthetic" });
    // The server has accepted the side effect; crash before success is journaled.
    await new Promise(() => {});
  },
};
await executeJournaled(spec, { text: "synthetic" }, { runId, userId, conversationId, toolCallId: "crash-call" });
