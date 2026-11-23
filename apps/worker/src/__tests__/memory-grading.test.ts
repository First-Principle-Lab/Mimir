import { expect, test } from "bun:test";
import { parseMemoryGrades } from "../../../../evals/memory/grading.js";
test("memory grading counts records and annotations separately", () => {
  expect(
    parseMemoryGrades(
      JSON.stringify({
        supported: [true, true, false],
        covered: [true, false],
        invented: [false, false, true],
        stale: [false, false, false],
      }),
      3,
      2,
    ),
  ).toEqual({ supported: 2, covered: 1, invented: 1, stale: 0, notes: "" });
  expect(() =>
    parseMemoryGrades(
      '{"supported":3,"covered":3,"invented":0,"stale":0}',
      3,
      2,
    ),
  ).toThrow("expected 3 booleans");
  expect(() =>
    parseMemoryGrades(
      '{"supported":[true,true,true],"covered":[true,true,true]}',
      3,
      2,
    ),
  ).toThrow("expected 2 booleans");
});
