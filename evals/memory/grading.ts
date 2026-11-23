// The judge labels named records/annotations; code computes counts. Never clamp
// invalid judgments into plausible scores or silently drop missing labels.
export function parseMemoryGrades(
  text: string,
  recordTexts: readonly string[],
  annotationCount: number,
) {
  const value = JSON.parse(text.replace(/```(?:json)?|```/g, "").trim());
  const exactKeys = (
    value: unknown,
    prefix: string,
    count: number,
  ): Record<string, unknown> => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== count ||
      Array.from({ length: count }, (_, i) => `${prefix}_${i}`).some(
        (key) => !(key in value),
      )
    )
      throw new Error(`Invalid extraction labels ${prefix}`);
    return value as Record<string, unknown>;
  };
  const records = exactKeys(value.records, "record", recordTexts.length);
  const annotations = exactKeys(
    value.annotations,
    "annotation",
    annotationCount,
  );
  const counts = {
    supported: 0,
    covered: 0,
    invented: 0,
    stale: 0,
    notes: typeof value.notes === "string" ? value.notes : "",
  };
  for (const label of Object.values(records)) {
    const r = label as Record<string, unknown>;
    for (const key of ["supported", "invented", "stale"] as const) {
      if (!r || typeof r[key] !== "boolean")
        throw new Error("Invalid record judgment");
      if (r[key]) counts[key]++;
    }
  }
  for (const [key, label] of Object.entries(annotations)) {
    const a = label as { covered?: unknown; evidence?: unknown };
    if (
      !a ||
      typeof a.covered !== "boolean" ||
      typeof a.evidence !== "string" ||
      (a.covered
        ? !a.evidence ||
          !recordTexts.some((t) => t.includes(a.evidence as string))
        : a.evidence !== "")
    )
      throw new Error(
        `Invalid extraction coverage evidence for ${key}: quotation absent from extracted records or inconsistent with covered label`,
      );
    if (a.covered) counts.covered++;
  }
  return counts;
}
