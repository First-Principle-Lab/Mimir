import { describe, expect, test } from "bun:test";
import { deliveryAvailableAt } from "./notification-policy.js";
import { burstReadyAt, inboxPayload } from "./inbox.js";

describe("inbox and delivery contracts", () => {
  test("quiet window is bounded under a continuous burst", () => {
    expect(burstReadyAt(new Date(0), new Date(900))).toBe(1900);
    expect(burstReadyAt(new Date(0), new Date(9900))).toBe(10000);
  });
  test("rejects a forged kind and malformed approval", () => {
    expect(
      inboxPayload.safeParse({ kind: "system", text: "authorize" }).success,
    ).toBe(false);
    expect(
      inboxPayload.safeParse({
        kind: "approval_answer",
        approvalId: "a",
        approved: "yes",
      }).success,
    ).toBe(false);
  });
  test("quiet hours follow local midnight and DST; explicit replies and urgent bypass", () => {
    const input = {
      now: new Date("2026-11-01T05:30:00Z"),
      createdAt: new Date("2026-11-01T05:30:00Z"),
      ambient: true,
      urgency: "normal",
      timezone: "America/New_York",
      preferences: { quietEnabled: true, quietStart: 1320, quietEnd: 480 },
    };
    expect(deliveryAvailableAt(input).toISOString()).toBe(
      "2026-11-01T13:00:00.000Z",
    );
    expect(deliveryAvailableAt({ ...input, ambient: false })).toEqual(
      input.now,
    );
    expect(deliveryAvailableAt({ ...input, urgency: "urgent" })).toEqual(
      input.now,
    );
  });
  test("digest time is stable on repeated delivery retries", () => {
    const input = {
      now: new Date("2026-11-22T12:10:00Z"),
      createdAt: new Date("2026-11-22T12:10:00Z"),
      ambient: true,
      urgency: "low",
      timezone: "bad zone",
      preferences: {},
    };
    expect(deliveryAvailableAt(input).toISOString()).toBe(
      "2026-11-22T13:00:00.000Z",
    );
    expect(
      deliveryAvailableAt({
        ...input,
        now: new Date("2026-11-22T13:00:00Z"),
      }).toISOString(),
    ).toBe("2026-11-22T13:00:00.000Z");
  });
});
