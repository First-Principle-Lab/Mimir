import { describe, expect, test } from "bun:test";
import {
  buildRuntimeContext,
  formatLocalTime,
  localDayWindow,
} from "../harness/context.js";

const NOW = new Date("2026-11-22T16:10:00Z");

test("calendar day boundaries use each date's offset, including DST and skipped midnight", () => {
  expect(
    localDayWindow(new Date("2026-11-01T16:00:00Z"), "America/New_York"),
  ).toEqual({
    start: "2026-11-01T04:00:00.000Z",
    end: "2026-11-02T05:00:00.000Z",
  });
  expect(
    localDayWindow(new Date("2026-03-08T16:00:00Z"), "America/New_York"),
  ).toEqual({
    start: "2026-03-08T05:00:00.000Z",
    end: "2026-03-09T04:00:00.000Z",
  });
  expect(
    localDayWindow(new Date("2018-11-04T12:00:00Z"), "America/Sao_Paulo"),
  ).toEqual({
    start: "2018-11-04T03:00:00.000Z",
    end: "2018-11-05T02:00:00.000Z",
  });
  expect(
    localDayWindow(new Date("2026-11-22T20:00:00Z"), "Asia/Kolkata"),
  ).toEqual({
    start: "2026-11-22T18:30:00.000Z",
    end: "2026-11-23T18:30:00.000Z",
  });
});

describe("formatLocalTime", () => {
  test("renders weekday, date, 24h time and offset in the user's zone", () => {
    expect(formatLocalTime(NOW, "Asia/Kolkata")).toBe(
      "Sunday, 22 November 2026, 21:40 (Asia/Kolkata, GMT+5:30)",
    );
  });

  test("the local date can differ from the UTC date", () => {
    expect(
      formatLocalTime(new Date("2026-11-22T20:00:00Z"), "Asia/Tokyo"),
    ).toStartWith("Monday, 23 November 2026, 05:00");
  });

  test("falls back to UTC for a missing or invalid zone", () => {
    expect(formatLocalTime(NOW, null)).toMatch(
      /^Sunday, 22 November 2026, 16:10 \(UTC, GMT(\+0)?\)$/,
    );
    expect(formatLocalTime(NOW, "Not/AZone")).toContain("(UTC,");
  });
});

describe("buildRuntimeContext", () => {
  test("wraps time and zone in a runtime_context block", () => {
    const ctx = buildRuntimeContext({
      now: NOW,
      timezone: "Asia/Kolkata",
      facts: [],
    });
    expect(ctx).toStartWith("<runtime_context>");
    expect(ctx).toEndWith("</runtime_context>");
    expect(ctx).toContain(
      "Current local time: Sunday, 22 November 2026, 21:40",
    );
    expect(ctx).toContain("User time zone: Asia/Kolkata");
    expect(ctx).not.toContain("Remembered facts");
  });

  test("says when the zone isn't set", () => {
    expect(
      buildRuntimeContext({ now: NOW, timezone: null, facts: [] }),
    ).toContain("User time zone: UTC (not set;");
  });

  test("lists remembered facts as possibly outdated", () => {
    const ctx = buildRuntimeContext({
      now: NOW,
      timezone: "UTC",
      facts: [{ subject: "manager", fact: "Priya is the user's manager" }],
    });
    expect(ctx).toContain(
      "Remembered facts (may be outdated):\n- manager: Priya is the user's manager",
    );
  });
});
