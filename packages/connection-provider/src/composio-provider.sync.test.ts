import { beforeEach, mock } from "bun:test";
import { describe, expect, test } from "bun:test";

// Mock @composio/core BEFORE importing the provider so syncConnection's live
// lookups hit a fake connectedAccounts.list (for the account id) and a fake
// tools.proxyExecute (for the profile health probe). `account` flips to simulate
// Composio having (or losing) the user's ACTIVE gmail account; `probeStatus`
// flips to simulate a dead connection.
let account: { id: string } | null = { id: "ca-active" };
let probeStatus = 200;
let probeEndpoint = "";
let listArgs: { userIds?: string[]; toolkitSlugs?: string[]; statuses?: string[] } | null = null;
mock.module("@composio/core", () => {
  class Composio {
    connectedAccounts = {
      list: async (args: { userIds?: string[]; toolkitSlugs?: string[]; statuses?: string[] }) => {
        listArgs = args;
        return { items: account ? [account] : [] };
      },
    };
    tools = {
      proxyExecute: async (body: { endpoint: string }) => {
        probeEndpoint = body.endpoint;
        return { status: probeStatus, data: { emailAddress: "a@example.com" } };
      },
    };
  }
  return { Composio };
});

const { ComposioConnectionProvider } = await import("./composio-provider.js");
type Provider = InstanceType<typeof ComposioConnectionProvider>;

function store(initial: { connectionId: string; status: string } | null) {
  let row = initial;
  return {
    store: {
      async findFirst() {
        return row ? { id: "r1", ...row } : null;
      },
      async update({ data }: { data: { connectionId: string; status: string } }) {
        row = { connectionId: data.connectionId, status: data.status };
      },
      async create({ data }: { data: { connectionId: string; status: string } }) {
        row = { connectionId: data.connectionId, status: data.status };
      },
      async delete() {
        row = null;
      },
    },
    row: () => row,
  };
}

function provider(s: ReturnType<typeof store>): Provider {
  return new ComposioConnectionProvider({ apiKey: "k", authConfigId: "ac_x", store: s.store });
}

describe("ComposioConnectionProvider syncConnection (stale-row heal)", () => {
  beforeEach(() => {
    probeStatus = 200;
  });

  test("heals an expired row back to connected when Composio has the account ACTIVE", async () => {
    const s = store({ connectionId: "ca-stale", status: "expired" });
    expect(await provider(s).syncConnection("user-1")).toBe(true);
    expect(s.row()).toEqual({ connectionId: "ca-active", status: "connected" });
  });

  test("creates a row when none exists and Composio has an ACTIVE account", async () => {
    const s = store(null);
    expect(await provider(s).syncConnection("user-1")).toBe(true);
    expect(s.row()).toEqual({ connectionId: "ca-active", status: "connected" });
  });

  test("returns false when Composio has no ACTIVE account", async () => {
    const s = store({ connectionId: "ca-stale", status: "expired" });
    account = null;
    try {
      expect(await provider(s).syncConnection("user-1")).toBe(false);
      expect(s.row()).toEqual({ connectionId: "ca-stale", status: "expired" });
    } finally {
      account = { id: "ca-active" };
    }
  });

  test("does not heal when the connection probe is dead (non-200)", async () => {
    const s = store({ connectionId: "ca-active", status: "expired" });
    probeStatus = 401;
    try {
      expect(await provider(s).syncConnection("user-1")).toBe(false);
      expect(s.row()).toEqual({ connectionId: "ca-active", status: "expired" });
    } finally {
      probeStatus = 200;
    }
  });
});

describe("ComposioConnectionProvider parameterized (non-gmail toolkits)", () => {
  beforeEach(() => {
    probeStatus = 200;
    listArgs = null;
    probeEndpoint = "";
  });

  test("a github-configured instance uses its own slug, probe path, and row key", async () => {
    const s = store(null);
    const p = new ComposioConnectionProvider({
      apiKey: "k",
      authConfigId: "ac_g",
      store: s.store,
      providerKey: "github",
      toolkitSlug: "github",
      probePath: "/user",
    });
    expect(await p.syncConnection("user-1")).toBe(true);
    expect(listArgs?.toolkitSlugs).toEqual(["github"]);
    expect(probeEndpoint).toBe("/user");
    expect(s.row()).toEqual({ connectionId: "ca-active", status: "connected" });
  });
});
