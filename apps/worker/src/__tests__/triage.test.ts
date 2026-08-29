process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "triage-test-secret";

import { describe, expect, test } from "bun:test";
const { parseTriage, promptForKind } = await import("../agent/triage.js");

describe("parseTriage (6.5.5 stricter bar)", () => {
  test("only an explicit true surfaces", () => {
    expect(parseTriage('{"surface":true,"rationale":"urgent","category":"actionable"}')).toEqual({
      surface: true,
      rationale: "urgent",
      category: "actionable",
    });
    expect(parseTriage('{"surface":false,"rationale":"newsletter","category":"noise"}').surface).toBe(false);
  });

  test("missing surface / unknown category / unparseable default to false + noise", () => {
    expect(parseTriage('{"rationale":"nope"}').surface).toBe(false);
    expect(parseTriage('{"surface":true,"category":"weird"}').category).toBe("noise");
    expect(parseTriage("not json").surface).toBe(false);
  });
});

describe("promptForKind (monitor system prompts)", () => {
  test("each provider monitor gets its own instruction set; unknown falls back to email", () => {
    const email = promptForKind();
    const github = promptForKind("github");
    const cal = promptForKind("googlecalendar");
    expect(github).toContain("GitHub Monitor");
    expect(cal).toContain("Calendar Monitor");
    expect(email).toContain("judge whether an incoming email");
    expect(github).not.toBe(email);
    expect(cal).not.toBe(email);
    // Every monitor prompt keeps the strict default-to-false + STRICT JSON contract
    // the triage parser expects. A missing surface must never surface.
    expect(cal).toMatch(/prefer NOT surfacing|err toward silence|doesn't clear the bar/i);
    expect(cal).toContain("STRICT JSON");
    expect(github).toContain("STRICT JSON");
  });
});
