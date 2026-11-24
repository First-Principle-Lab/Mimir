import { expect, test } from "bun:test";
import { parseMemoryGrades } from "../../../../evals/memory/grading.js";
test("memory grading requires exact record/annotation labels and real evidence", () => {
  const data = {
    records: {
      record_0: { supported: true, invented: false, stale: false },
      record_1: { supported: false, invented: true, stale: false },
    },
    annotations: {
      annotation_0: { covered: true, evidence: ["fact A", "fact B"] },
      annotation_1: { covered: false, evidence: [] as string[] },
      annotation_2: { covered: false, evidence: [] as string[] },
    },
  };
  const grade = () =>
    parseMemoryGrades(JSON.stringify(data), ["fact A", "fact B"], 3);
  expect(grade()).toEqual({
    supported: 1,
    covered: 1,
    invented: 1,
    stale: 0,
    notes: "",
  });
  data.annotations.annotation_0.evidence = ["invented quotation"];
  expect(grade).toThrow("coverage evidence");
  expect(() =>
    parseMemoryGrades(JSON.stringify(data), ["fact A", "fact B"], 2),
  ).toThrow("labels annotation");
  expect(() => parseMemoryGrades('{"supported":3}', ["fact A"], 1)).toThrow(
    "labels record",
  );
});
