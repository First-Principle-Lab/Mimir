import { z } from "zod";

export const notificationPreferences = z.object({
  quietStart: z.number().int().min(0).max(1439).default(1320),
  quietEnd: z.number().int().min(0).max(1439).default(480),
  quietEnabled: z.boolean().default(false),
  digestMinutes: z.number().int().min(1).max(1440).default(60),
});

function minuteAt(now: Date, timezone: string | null): number {
  let timeZone = timezone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    timeZone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return (
    Number(parts.find((p) => p.type === "hour")!.value) * 60 +
    Number(parts.find((p) => p.type === "minute")!.value)
  );
}
export function deliveryAvailableAt(input: {
  now: Date;
  createdAt: Date;
  ambient: boolean;
  urgency: string;
  timezone: string | null;
  preferences: unknown;
}): Date {
  if (!input.ambient || input.urgency === "urgent") return input.now;
  const p = notificationPreferences.parse(input.preferences ?? {});
  const digestMs = p.digestMinutes * 60_000;
  let at =
    input.urgency === "low"
      ? Math.max(
          input.now.getTime(),
          Math.ceil((input.createdAt.getTime() + 1) / digestMs) * digestMs,
        )
      : input.now.getTime();
  // Walking instants instead of adding an offset handles DST folds/skips.
  for (let i = 0; i < 2880; i++, at += 60_000) {
    const minute = minuteAt(new Date(at), input.timezone);
    const quiet =
      p.quietEnabled &&
      p.quietStart !== p.quietEnd &&
      (p.quietStart < p.quietEnd
        ? minute >= p.quietStart && minute < p.quietEnd
        : minute >= p.quietStart || minute < p.quietEnd);
    if (!quiet) return new Date(at);
  }
  return new Date(at);
}
