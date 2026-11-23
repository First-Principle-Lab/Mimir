"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { disablePush, enablePush, inDesktopShell, pushEnabled } from "@/lib/push";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000/api/v1";

interface Integration {
  key: string;
  label: string;
  connected: boolean;
}

interface AgentDefinitionRow {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  canSpawn: boolean;
  maxSteps: number;
  maxUsd: number;
  timeoutSec: number;
}

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  status: string;
  lastError?: string | null;
}

export default function SettingsPage() {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [servers, setServers] = useState<McpServerRow[]>([]);
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [definitions, setDefinitions] = useState<AgentDefinitionRow[]>([]);
  const [agentDraft, setAgentDraft] = useState({
    name: "",
    description: "",
    prompt: "",
    canSpawn: false,
  });
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<boolean | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [a, b, d] = await Promise.all([
      fetch(`${API}/integrations`, { credentials: "include" }),
      fetch(`${API}/mcp/servers`, { credentials: "include" }),
      fetch(`${API}/agent-definitions`, { credentials: "include" }),
    ]);
    if (a.ok) setIntegrations(((await a.json()) as { integrations: Integration[] }).integrations);
    if (b.ok) setServers(((await b.json()) as { servers: McpServerRow[] }).servers);
    if (d.ok) setDefinitions(((await d.json()) as { definitions: AgentDefinitionRow[] }).definitions);
  }, []);

  useEffect(() => {
    void refresh();
    void pushEnabled().then(setNotifications);
  }, [refresh]);

  const togglePush = async () => {
    setPushBusy(true);
    setError(null);
    try {
      if (notifications) {
        await disablePush();
        setNotifications(false);
      } else {
        const ok = await enablePush();
        setNotifications(ok);
        if (!ok) setError("Notifications require granting permission in the browser.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update notifications.");
    } finally {
      setPushBusy(false);
    }
  };

  const connect = async (key: string) => {
    setError(null);
    const res = await fetch(`${API}/integrations/${key}/connect`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(body?.error?.message ?? "Could not start the connect flow (is Nango configured?)");
      return;
    }
    const { sessionToken, authorizationUrl, alreadyConnected } = (await res.json()) as {
      sessionToken?: string;
      authorizationUrl?: string;
      alreadyConnected?: boolean;
    };
    if (alreadyConnected) {
      void refresh();
      return;
    }
    // Composio hands a redirect URL; Nango a session token for its in-page widget.
    if (authorizationUrl) {
      window.location.href = authorizationUrl;
      return;
    }
    if (!sessionToken) {
      setError("Could not start the connect flow (is Nango configured?)");
      return;
    }
    const { default: Nango } = await import("@nangohq/frontend");
    new Nango({ connectSessionToken: sessionToken }).openConnectUI({
      onEvent: (event) => {
        if (event.type === "connect") {
          setError(null);
          void refresh();
          window.location.reload();
        }
        if (event.type === "error") {
          const cancelled =
            event.payload.errorType === "window_closed" ||
            /access_denied/i.test(event.payload.errorMessage);
          if (!cancelled) setError("Connect didn't complete — try again");
        }
      },
    });
  };

  const disconnect = async (it: Integration) => {
    setError(null);
    const res = await fetch(`${API}/integrations/${it.key}/disconnect`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      setError(`Couldn't disconnect ${it.label}`);
      return;
    }
    void refresh();
  };

  const disconnectAll = async () => {
    setError(null);
    const connected = integrations.filter((i) => i.connected);
    const results = await Promise.allSettled(
      connected.map((it) =>
        fetch(`${API}/integrations/${it.key}/disconnect`, { method: "POST", credentials: "include" }),
      ),
    );
    const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)).length;
    if (failed > 0) setError(`Couldn't disconnect ${failed} integration${failed === 1 ? "" : "s"}`);
    void refresh();
  };

  const addMcp = async () => {
    setError(null);
    if (!mcpName.trim() || !mcpUrl.trim()) {
      setError("Name and URL are required");
      return;
    }
    const res = await fetch(`${API}/mcp/servers`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: mcpName.trim(), url: mcpUrl.trim() }),
    });
    if (!res.ok) {
      setError("Failed to add MCP server");
      return;
    }
    setMcpName("");
    setMcpUrl("");
    void refresh();
  };

  const removeMcp = async (id: string) => {
    await fetch(`${API}/mcp/servers/${id}`, { method: "DELETE", credentials: "include" });
    void refresh();
  };

  const addAgent = async () => {
    setAgentError(null);
    const res = await fetch(`${API}/agent-definitions`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: agentDraft.name.trim(),
        description: agentDraft.description.trim(),
        prompt: agentDraft.prompt.trim(),
        canSpawn: agentDraft.canSpawn,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setAgentError(body?.error?.message ?? "Couldn't save the agent");
      return;
    }
    setAgentDraft({ name: "", description: "", prompt: "", canSpawn: false });
    void refresh();
  };

  const removeAgent = async (id: string) => {
    await fetch(`${API}/agent-definitions/${id}`, { method: "DELETE", credentials: "include" });
    void refresh();
  };

  const connectedCount = integrations.filter((i) => i.connected).length;

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <main className="mx-auto w-full max-w-3xl space-y-6 px-5 py-8">
        <Link
          href="/chat"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back to chat
        </Link>
        <h1 className="font-condensed text-2xl font-semibold">Settings</h1>

        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Notifications</h2>
          <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
            <div>
              <div className="text-sm">{inDesktopShell() ? "Desktop notifications" : "Browser push"}</div>
              <div className="text-xs text-muted-foreground">
                {inDesktopShell()
                  ? "OS notification when the app window isn't focused."
                  : "Wake-ups when the app is closed or on another tab."}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void togglePush()}
              disabled={pushBusy}
              className="cursor-pointer rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:border-border-strong disabled:opacity-50"
            >
              {pushBusy ? "…" : notifications ? "Disable" : "Enable"}
            </button>
          </div>
          {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Connections</h2>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {connectedCount === 0 ? "No integrations connected" : `${connectedCount} connected`}
            </p>
            {connectedCount > 0 ? (
              <button
                type="button"
                onClick={() => void disconnectAll()}
                className="cursor-pointer rounded-md border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-red-400/50 hover:text-red-300 focus-visible:outline-none"
              >
                Disconnect all
              </button>
            ) : null}
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {integrations.map((it) => (
              <li key={it.key} className="flex items-center justify-between px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${it.connected ? "bg-emerald-400" : "border border-muted-foreground"}`} />
                  <span className="text-sm">{it.label}</span>
                </div>
                {it.connected ? (
                  <span className="flex items-center gap-3">
                    <span className="text-xs text-emerald-400">Connected</span>
                    <button
                      type="button"
                      onClick={() => void disconnect(it)}
                      className="cursor-pointer rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-red-400/50 hover:text-red-300"
                    >
                      Disconnect
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connect(it.key)}
                    className="cursor-pointer rounded-md border border-border px-3 py-1 text-xs text-foreground transition-colors hover:border-border-strong"
                  >
                    Connect
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-1 text-sm font-medium text-muted-foreground">Background agents</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Mimir can hand longer work to these read-only agents. Your own agents are available to it by name;
            they never message you and propose changes instead of making them.
          </p>
          <div className="mb-4 flex flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={agentDraft.name}
                onChange={(e) => setAgentDraft({ ...agentDraft, name: e.target.value })}
                placeholder="name, e.g. inbox-triage"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <input
                value={agentDraft.description}
                onChange={(e) => setAgentDraft({ ...agentDraft, description: e.target.value })}
                placeholder="What it's for"
                className="flex-[2] rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <textarea
              value={agentDraft.prompt}
              onChange={(e) => setAgentDraft({ ...agentDraft, prompt: e.target.value })}
              placeholder="Instructions: how this agent should work"
              rows={3}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={agentDraft.canSpawn}
                  onChange={(e) => setAgentDraft({ ...agentDraft, canSpawn: e.target.checked })}
                />
                Can hand parts of its work to helpers
              </label>
              <button
                type="button"
                onClick={() => void addAgent()}
                className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-border-strong"
              >
                Add agent
              </button>
            </div>
          </div>
          {agentError ? <p className="mb-3 text-xs text-red-400">{agentError}</p> : null}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {definitions.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-sm">{d.name}</div>
                  <div className="truncate text-xs text-muted-foreground" title={d.description}>
                    {d.description}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {d.maxSteps} steps · ${d.maxUsd} · {Math.round(d.timeoutSec / 60)} min
                    {d.canSpawn ? " · uses helpers" : ""}
                  </div>
                </div>
                {d.builtIn ? (
                  <span className="shrink-0 text-xs text-muted-foreground">Built in</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void removeAgent(d.id)}
                    className="shrink-0 cursor-pointer text-xs text-red-400"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium text-muted-foreground">Custom MCP servers</h2>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row">
            <input
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
              placeholder="Name"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <input
              value={mcpUrl}
              onChange={(e) => setMcpUrl(e.target.value)}
              placeholder="https://mcp.example.com/mcp"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void addMcp()}
              className="cursor-pointer rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:border-border-strong"
            >
              Add
            </button>
          </div>
          {error ? <p className="mb-3 text-xs text-red-400">{error}</p> : null}
          <ul className="divide-y divide-border rounded-lg border border-border">
            {servers.map((s) => (
              <li key={s.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm">{s.name}</div>
                  <div className="text-xs text-muted-foreground">{s.url}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{s.status}</span>
                  <button
                    type="button"
                    onClick={() => void removeMcp(s.id)}
                    className="cursor-pointer text-xs text-red-400"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
