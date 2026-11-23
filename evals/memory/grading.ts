// A judge labels each record/annotation; only code computes aggregate counts.
// Invalid judgments fail the run instead of being clamped into plausible scores.
export function parseMemoryGrades(
  text: string,
  records: number,
  annotations: number,
) {
  const value = JSON.parse(
    text.replace(/```(?:json)?|```/g, "").trim(),
  ) as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const [key, size] of [
    ["supported", records],
    ["covered", annotations],
    ["invented", records],
    ["stale", records],
  ] as const) {
    const labels = value[key];
    if (
      !Array.isArray(labels) ||
      labels.length !== size ||
      labels.some((v) => typeof v !== "boolean")
    )
      throw new Error(
        `Invalid extraction labels ${key}: expected ${size} booleans`,
      );
    counts[key] = labels.filter(Boolean).length;
  }
  return {
    supported: counts.supported!,
    covered: counts.covered!,
    invented: counts.invented!,
    stale: counts.stale!,
    notes: typeof value.notes === "string" ? value.notes : "",
  };
}
