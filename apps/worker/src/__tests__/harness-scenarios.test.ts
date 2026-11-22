import { expect, test } from "bun:test";
import {
  scenarios,
  scoreScenario,
} from "../../../../evals/harness/scenarios.js";

test("scoring fails missing combined tools and prohibited actions", () => {
  const scenario = scenarios.find((s) => s.id === "combined-request")!;
  expect(
    scoreScenario(scenario, [{ name: "send_email", args: {} }], "NO_REPLY"),
  ).toContain("forbidden tool: send_email");
  expect(scoreScenario(scenario, [], "Invoice and Planning")).toContain(
    "missing tool: calendar_list_events",
  );
  expect(
    scoreScenario(
      scenario,
      [
        { name: "search_email", args: {} },
        {
          name: "calendar_list_events",
          args: {
            timeMin: scenario.calendarWindow!.start,
            timeMax: scenario.calendarWindow!.end,
          },
        },
      ],
      "Invoice and Planning",
    ),
  ).toEqual([]);
});

test("date scoring compares instants, accepting offsets and rejecting UTC day boundaries", () => {
  const scenario = scenarios.find((s) => s.id === "local-midnight")!;
  const call = (timeMin: string, timeMax: string) => [
    { name: "calendar_list_events", args: { timeMin, timeMax } },
  ];
  expect(
    scoreScenario(
      scenario,
      call("2026-11-23T00:00:00+05:30", "2026-11-24T00:00:00+05:30"),
      "Planning",
    ),
  ).toEqual([]);
  expect(
    scoreScenario(
      scenario,
      call("2026-11-23T00:00:00Z", "2026-11-24T00:00:00Z"),
      "Planning",
    ),
  ).toContain("incorrect local day start");
});
