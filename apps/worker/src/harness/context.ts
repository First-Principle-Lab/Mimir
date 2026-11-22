import type { FactHit } from "@mimir/backend-core";

// The per-turn runtime context: everything volatile the model needs that must
// NOT live in the system prompt (that stays static so the provider can cache it).
// Injected right before the latest user message on every model call, never stored.

export interface RuntimeContextInput {
  now: Date;
  timezone: string | null;
  facts: Pick<FactHit, "subject" | "fact">[];
}

function validTimezone(tz: string | null): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

// "Sunday, 22 November 2026, 21:40 (Asia/Kolkata, GMT+5:30)"
export function formatLocalTime(now: Date, timezone: string | null): string {
  const tz = validTimezone(timezone);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")} (${tz}, ${get("timeZoneName")})`;
}

export function buildRuntimeContext(input: RuntimeContextInput): string {
  const lines = [
    "<runtime_context>",
    `Current local time: ${formatLocalTime(input.now, input.timezone)}`,
    `User time zone: ${validTimezone(input.timezone)}${input.timezone ? "" : " (not set; assume UTC and say so if it matters)"}`,
    "Running background agents: none (not enabled yet)",
  ];
  if (input.facts.length > 0) {
    lines.push("Remembered facts (may be outdated):");
    for (const f of input.facts) lines.push(`- ${f.subject}: ${f.fact}`);
  }
  lines.push("</runtime_context>");
  return lines.join("\n");
}
