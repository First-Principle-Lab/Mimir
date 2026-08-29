import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "notion-test-secret";

const { ConnectionError, ProviderError } = await import("@mimir/connection-provider");
const { fetchNotionPages } = await import("../../integrations/notion/notion.js");

// A fake transport returning { status, data } — the same contract Composio's
// proxyExecute surfaces to http-rpc. Drives status-dependent error mapping
// without a live provider.
function requestReturning(status: number, data: unknown) {
  return async () => ({ status, data });
}

describe("fetchNotionPages (REST layer)", () => {
  test("maps search results to the page shape", async () => {
    const pages = await fetchNotionPages(
      requestReturning(200, {
        results: [
          {
            id: "p1",
            url: "https://notion.so/p1",
            last_edited_time: "2024-08-02T12:00:00.000Z",
            properties: { title: { title: [{ plain_text: "Q3 Plans" }] } },
          },
        ],
      }),
      "plans",
    );
    expect(pages).toEqual([
      { id: "p1", title: "Q3 Plans", url: "https://notion.so/p1", lastEditedAt: "2024-08-02T12:00:00.000Z" },
    ]);
  });

  test("maps auth errors to ConnectionError (fail-fast reconnect)", async () => {
    await expect(fetchNotionPages(requestReturning(401, {}), "x")).rejects.toBeInstanceOf(ConnectionError);
  });

  test("maps provider outages to ProviderError (retriable)", async () => {
    await expect(fetchNotionPages(requestReturning(503, {}), "x")).rejects.toBeInstanceOf(ProviderError);
  });
});