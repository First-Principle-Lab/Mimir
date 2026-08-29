import { describe, expect, test } from "bun:test";

process.env.DATABASE_URL = "postgres://mimir:mimir@localhost:5434/mimir";
process.env.REDIS_URL = "redis://localhost:6380";
process.env.JWT_SECRET = "integrations-rpc-test-secret";

const { ConnectionError, ProviderError } = await import("@mimir/connection-provider");
const { fetchCalendarEvents } = await import("../integrations/calendar/calendar.js");
const { fetchRepoIssues, fetchTrackedRepos } = await import("../integrations/github/github.js");

// Both new providers route through the shared http-rpc mapping; these tests pin
// that mapping on the actual call paths (a gmail/notion test already proves the
// mapping itself).
function requestReturning(status: number, data: unknown) {
  return async () => ({ status, data });
}

describe("calendar + github REST layers (shared rpc error mapping)", () => {
  test("calendar maps 403 to ConnectionError(expired)", async () => {
    await expect(fetchCalendarEvents(requestReturning(403, {}), {})).rejects.toBeInstanceOf(ConnectionError);
  });

  test("calendar maps 429 to ProviderError(rate_limited)", async () => {
    await expect(fetchCalendarEvents(requestReturning(429, {}), {})).rejects.toBeInstanceOf(ProviderError);
  });

  test("github issue list maps 403 to ConnectionError(expired)", async () => {
    await expect(fetchRepoIssues(requestReturning(403, {}), "owner/repo", {})).rejects.toBeInstanceOf(ConnectionError);
  });

  test("github trimmed repo list maps 429 to ProviderError(rate_limited)", async () => {
    await expect(fetchTrackedRepos(requestReturning(429, {}), 5)).rejects.toBeInstanceOf(ProviderError);
  });
});