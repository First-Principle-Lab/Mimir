"use client";
import { useState } from "react";
export interface Approval {
  id: string;
  toolName: string;
  arguments: unknown;
  argumentHash: string;
  status: string;
  expiresAt: string;
  risk: string;
}
export function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: Approval;
  onDecision: (approval: Approval, approved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending =
    approval.status === "pending" &&
    Date.parse(approval.expiresAt) > Date.now();
  const decide = async (approved: boolean) => {
    setBusy(true);
    setError("");
    try {
      await onDecision(approval, approved);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save your decision",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Review action"
      className="my-4 rounded-lg border border-border bg-secondary/40 p-4"
    >
      <h2 className="font-medium">{approval.toolName.replaceAll("_", " ")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {pending
          ? "Review the details below. Approving runs this action once."
          : "Status: " +
            (approval.status === "pending" ? "expired" : approval.status)}
      </p>
      <pre className="my-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-3 text-xs">
        {JSON.stringify(approval.arguments, null, 2)}
      </pre>
      {pending && (
        <div className="flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(true)}
            className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(false)}
            className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
