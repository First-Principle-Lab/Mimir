"use client";
import { useState } from "react";

export interface BackgroundAgent {
  id: string;
  agent: string;
  status: string;
  objective: string;
  summary: string;
  helpers: number;
  costUsd: number;
  startedAt: string;
  finishedAt: string | null;
}

export const ACTIVE_AGENT_STATUSES = ["queued", "running"];

const STATUS_LABELS: Record<string, string> = {
  queued: "Waiting to start",
  running: "Working",
  succeeded: "Done",
  failed: "Failed",
  timeout: "Ran out of time",
  budget_exceeded: "Hit its budget",
  interrupted: "Interrupted",
  canceled: "Canceled",
};

// The conversation's background agents. Reports come from tool content and
// are rendered as plain text, never as markdown or links.
export function AgentsPanel({
  agents,
  onCancel,
}: {
  agents: BackgroundAgent[];
  onCancel: (agent: BackgroundAgent) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!agents.length) return null;
  const cancel = async (agent: BackgroundAgent) => {
    setBusy(agent.id);
    setError("");
    try {
      await onCancel(agent);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel the agent");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-label="Background agents"
      className="my-4 rounded-lg border border-border bg-secondary/40 p-4"
    >
      <h2 className="font-medium">Background agents</h2>
      <ul className="mt-2 divide-y divide-border">
        {agents.map((a) => {
          const active = ACTIVE_AGENT_STATUSES.includes(a.status);
          return (
            <li key={a.id} className="py-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm" title={a.objective}>
                    {a.objective || a.agent}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {a.agent} · {STATUS_LABELS[a.status] ?? a.status}
                    {a.helpers ? ` · ${a.helpers} helpers` : ""} · $
                    {a.costUsd.toFixed(4)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-3">
                  {a.summary && !active ? (
                    <button
                      type="button"
                      onClick={() => setOpen(open === a.id ? null : a.id)}
                      className="text-xs text-muted-foreground hover:text-foreground"
                    >
                      {open === a.id ? "Hide report" : "Report"}
                    </button>
                  ) : null}
                  {active ? (
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => void cancel(a)}
                      className="text-xs text-red-400 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              </div>
              {open === a.id ? (
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 text-xs">
                  {a.summary}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </section>
  );
}
