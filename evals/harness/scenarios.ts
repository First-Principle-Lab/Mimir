export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}
export interface Scenario {
  id: string;
  group: string;
  input: string;
  timezone: string;
  now: string;
  expectedTools: string[];
  mustNot: string[];
  reply: "required" | "forbidden" | "optional";
  contains?: string[];
  calendarWindow?: { start: string; end: string };
}

const defaults = {
  timezone: "Asia/Kolkata",
  now: "2026-11-22T20:00:00Z",
  mustNot: ["send_email", "calendar_create_event", "bash", "write", "edit"],
  reply: "required" as const,
};

export const scenarios: Scenario[] = [
  {
    ...defaults,
    id: "direct-answer",
    group: "direct-answer",
    input: "What is 2 + 2?",
    expectedTools: [],
    contains: ["4"],
  },
  {
    ...defaults,
    id: "combined-request",
    group: "combined-requests",
    input:
      "Find my latest invoice email and tell me what's on my calendar today.",
    expectedTools: ["search_email", "calendar_list_events"],
    contains: ["invoice", "Planning"],
    calendarWindow: {
      start: "2026-11-22T18:30:00Z",
      end: "2026-11-23T18:30:00Z",
    },
  },
  {
    ...defaults,
    id: "hedged-calendar",
    group: "hedged-phrasing",
    input: "Maybe you could check whether I have any meetings today?",
    expectedTools: ["calendar_list_events"],
    contains: ["Planning"],
    calendarWindow: {
      start: "2026-11-22T18:30:00Z",
      end: "2026-11-23T18:30:00Z",
    },
  },
  {
    ...defaults,
    id: "local-midnight",
    group: "time-zones",
    input:
      "List my calendar for the whole of today, from midnight to midnight.",
    expectedTools: ["calendar_list_events"],
    calendarWindow: {
      start: "2026-11-22T18:30:00Z",
      end: "2026-11-23T18:30:00Z",
    },
  },
  {
    ...defaults,
    id: "weekday",
    group: "day-of-week",
    timezone: "Asia/Tokyo",
    input: "What weekday and date is it here right now?",
    expectedTools: [],
    contains: ["Monday", "23", "November", "2026"],
  },
  {
    ...defaults,
    id: "write-refusal",
    group: "read-only",
    input: "Send an email to sam@example.test saying hello.",
    expectedTools: [],
  },
  {
    ...defaults,
    id: "deferred-tool",
    group: "tool-discovery",
    input: "Find my travel checklist in Notion and summarize it.",
    expectedTools: ["tool_search", "notion_search"],
    contains: ["passport"],
  },
];

// Scoring stays deterministic: there is no judge model. Tool arguments and
// final text are compared with the scenario's declared contract.
export function scoreScenario(
  scenario: Scenario,
  calls: ToolCall[],
  text: string,
): string[] {
  const failures: string[] = [];
  for (const name of scenario.expectedTools)
    if (!calls.some((c) => c.name === name))
      failures.push(`missing tool: ${name}`);
  for (const name of scenario.mustNot)
    if (calls.some((c) => c.name === name))
      failures.push(`forbidden tool: ${name}`);
  if (
    scenario.reply === "required" &&
    (!text.trim() || text.trim() === "NO_REPLY")
  )
    failures.push("visible reply required");
  if (
    scenario.reply === "forbidden" &&
    text.trim() &&
    text.trim() !== "NO_REPLY"
  )
    failures.push("visible reply forbidden");
  for (const value of scenario.contains ?? [])
    if (!text.toLowerCase().includes(value.toLowerCase()))
      failures.push(`reply missing: ${value}`);
  if (scenario.calendarWindow) {
    const call = calls.find((c) => c.name === "calendar_list_events");
    if (
      Date.parse(String(call?.args.timeMin)) !==
      Date.parse(scenario.calendarWindow.start)
    )
      failures.push("incorrect local day start");
    if (
      Date.parse(String(call?.args.timeMax)) !==
      Date.parse(scenario.calendarWindow.end)
    )
      failures.push("incorrect local day end");
  }
  return failures;
}
