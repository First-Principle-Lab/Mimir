import { mock } from "bun:test";
import { describe, expect, test } from "bun:test";

// Nothing here calls composio() (no network), but the module graph imports
// @composio/core via composio-provider — stub it so the file loads standalone.
mock.module("@composio/core", () => ({ Composio: class {} }));

const { ComposioConnectionProvider } = await import("./composio-provider.js");
const { GITHUB_INTEGRATION, GOOGLE_CALENDAR_INTEGRATION, NOTION_INTEGRATION, composioProvider } = await import("./composio-providers.js");

// Never exercised by these tests (no provider method is called) — a bare object
// satisfies the store pointer.
const store = {} as import("./types.js").IntegrationConnectionStore;

describe("composioProvider factory", () => {
  test("maps each composio key to a provider instance", () => {
    for (const key of [GOOGLE_CALENDAR_INTEGRATION, GITHUB_INTEGRATION, NOTION_INTEGRATION]) {
      expect(composioProvider(key, { COMPOSIO_API_KEY: "k" }, store)).toBeInstanceOf(ComposioConnectionProvider);
    }
  });

  test("throws for an unknown roster key (no silent Nango fallback)", () => {
    expect(() => composioProvider("linear", { COMPOSIO_API_KEY: "k" }, store)).toThrow("unknown composio integration");
  });
});