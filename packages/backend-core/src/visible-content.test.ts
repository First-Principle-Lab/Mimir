import { expect, test } from "bun:test";
import { sanitizeVisibleText, visibleDomains } from "./visible-content.js";
test("model links cannot introduce unknown domains or remote tracking images", () => {
  const domains = visibleDomains(["Read https://docs.example.test/guide"]);
  const text = sanitizeVisibleText(
    "[source](https://docs.example.test/ok) [leak](https://unknown.example.test/?secret=abc) ![pixel](https://unknown.example.test/pixel) https://other.example.test/data <img src='https://tracker.example.test/a'>",
    domains,
  );
  expect(text).toContain("[source](https://docs.example.test/ok)");
  expect(text).not.toContain("unknown.example");
  expect(text).not.toContain("other.example");
  expect(text).not.toContain("tracker.example");
});
test("hostnames are exact and dangerous schemes and reference links are removed", () => {
  const text = sanitizeVisibleText(
    "[spoof](https://github.com.evil.example.test/a) [script](javascript:alert)\n[ref]: https://evil.example.test/x\n![known](https://github.com/pixel)\n[auth](https://user:pass@github.com/a)",
    visibleDomains([]),
  );
  expect(text).not.toContain("evil.example");
  expect(text).not.toContain("javascript:");
  expect(text).not.toContain("user:pass");
  expect(text).not.toContain("![known]");
});
