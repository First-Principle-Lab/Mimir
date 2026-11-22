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

// Resolve the actual start of each local date independently. Adding 24 hours
// or reusing the current offset fails on DST days (23/25 hours). Searching by
// local date also handles zones whose clocks skip midnight altogether.
export function localDayWindow(
  now: Date,
  timezone: string | null,
): {
  start: string;
  end: string;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: validTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localDate = (time: number) => {
    const parts = formatter.formatToParts(time);
    const get = (name: string) =>
      Number(parts.find((p) => p.type === name)!.value);
    return [get("year"), get("month"), get("day")] as const;
  };
  const [year, month, day] = localDate(now.getTime());
  const midnightUtc = Date.UTC(year, month - 1, day);
  const boundary = (utcDate: number) => {
    const target = new Date(utcDate);
    const key =
      target.getUTCFullYear() * 10000 +
      (target.getUTCMonth() + 1) * 100 +
      target.getUTCDate();
    let low = utcDate - 36 * 3600_000;
    let high = utcDate + 36 * 3600_000;
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2);
      const [y, m, d] = localDate(mid);
      if (y * 10000 + m * 100 + d < key) low = mid;
      else high = mid;
    }
    return new Date(high).toISOString();
  };
  return {
    start: boundary(midnightUtc),
    end: boundary(midnightUtc + 24 * 3600_000),
  };
}

export function buildRuntimeContext(input: RuntimeContextInput): string {
  const today = localDayWindow(input.now, input.timezone);
  const lines = [
    "<runtime_context>",
    `Current local time: ${formatLocalTime(input.now, input.timezone)}`,
    `User time zone: ${validTimezone(input.timezone)}${input.timezone ? "" : " (not set; assume UTC and say so if it matters)"}`,
    `Today's calendar range, already converted to UTC (start inclusive, end exclusive): ${today.start} to ${today.end}. Use these exact instants for the whole local day; DST can make it 23 or 25 hours.`,
    "Running background agents: none (not enabled yet)",
  ];
  if (input.facts.length > 0) {
    lines.push("Remembered facts (may be outdated):");
    for (const f of input.facts) lines.push(`- ${f.subject}: ${f.fact}`);
  }
  lines.push("</runtime_context>");
  return lines.join("\n");
}
