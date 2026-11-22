import { loadEnv } from "./_env.js";
import { appendRow, newRunId } from "./eval/lib.js";
import {
  scenarios,
  scoreScenario,
  type ToolCall,
} from "../evals/harness/scenarios.js";

loadEnv();
if (!process.env.OPENROUTER_API_KEY) {
  console.log("GATE NOT RUN: OPENROUTER_API_KEY missing");
  process.exit(2);
}

const { openSession, interactionModelId } =
  await import("../apps/worker/src/harness/pi-runtime.js");
const { buildRuntimeContext } =
  await import("../apps/worker/src/harness/context.js");
const { taskToSpec } = await import("../apps/worker/src/harness/tools.js");
const { gmailSearchTask } =
  await import("../apps/worker/src/integrations/gmail/gmail.js");
const { calendarListEventsTask } =
  await import("../apps/worker/src/integrations/calendar/calendar.js");
const { notionSearchTask } =
  await import("../apps/worker/src/integrations/notion/notion.js");
const runId = newRunId();
let passed = 0;

for (const scenario of scenarios) {
  // Real model + production schemas, prompt and extensions; integrations return
  // synthetic data. This suite cannot read an account or execute a write.
  const specs = [
    gmailSearchTask(),
    calendarListEventsTask(),
    notionSearchTask(),
  ].map((task) => {
    const spec = taskToSpec(task, {
      risk: "read_private",
      sideEffect: "none",
      resultTrust: "untrusted",
    });
    spec.execute = async () => {
      if (task.name === "search_email")
        return {
          messages: [
            {
              subject: "Quarterly invoice",
              snippet: "Invoice total: USD 120, due 30 November.",
            },
          ],
        };
      if (task.name === "calendar_list_events")
        return {
          events: [
            {
              summary: "Planning sync",
              start: "2026-11-23T10:00:00+05:30",
              end: "2026-11-23T10:30:00+05:30",
            },
          ],
        };
      return {
        pages: [
          {
            title: "Travel checklist",
            content: "Pack your passport and charger.",
          },
        ],
      };
    };
    return spec;
  });
  const calls: ToolCall[] = [];
  let session: Awaited<ReturnType<typeof openSession>> | undefined;
  let text = "";
  let failures: string[];
  try {
    session = await openSession({
      entries: [],
      specs,
      ctx: { userId: "synthetic-eval", conversationId: scenario.id },
      runtimeContext: () =>
        buildRuntimeContext({
          now: new Date(scenario.now),
          timezone: scenario.timezone,
          facts: [],
        }),
    });
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        for (const block of event.message.content)
          if (block.type === "toolCall")
            calls.push({ name: block.name, args: block.arguments });
      }
    });
    const timer = setTimeout(() => {
      void session?.abort();
    }, 60_000);
    try {
      await session.prompt(scenario.input);
      await session.waitForIdle();
    } finally {
      clearTimeout(timer);
    }
    for (const message of session.messages)
      if (message.role === "assistant") {
        const content = message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (content.trim()) text = content;
      }
    failures = scoreScenario(scenario, calls, text);
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)];
  } finally {
    session?.dispose();
  }
  if (failures.length === 0) passed++;
  appendRow("harness", runId, {
    scenario: scenario.id,
    group: scenario.group,
    model: interactionModelId(),
    mode: "live-model-synthetic-tools",
    calls,
    text,
    failures,
    passed: failures.length === 0,
  });
  console.log(
    `${failures.length ? "FAIL" : "PASS"} ${scenario.id}${failures.length ? `: ${failures.join("; ")}` : ""}`,
  );
}
console.log(
  `Harness: ${passed}/${scenarios.length} passed (real model, synthetic tools).`,
);
process.exit(passed === scenarios.length ? 0 : 1);
