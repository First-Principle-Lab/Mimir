import { getPrismaClient } from "./prisma.js";
import { tracer } from "./observability.js";

export type MemoryScope = "conversation" | "user" | "agent";
export interface MemoryNamespace {
  userId: string;
  conversationId: string;
  scope: MemoryScope;
  agentId?: string;
}
export interface MemoryRecord {
  userId: string;
  id: string;
  subject: string;
  fact: string;
  sourceMessageId: string | null;
  conversationId: string;
  scope: MemoryScope;
  agentId?: string;
  status: string;
  createdAt: string;
  supersedesId: string | null;
}
export interface MemoryWrite {
  subject: string;
  fact: string;
  sourceMessageId: string;
  replacesId?: string;
}
export interface ConversationHit {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}
export interface MemoryProvider {
  readonly id: string;
  readonly version: string;
  search(
    ns: MemoryNamespace,
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryRecord[]>;
  remember(
    ns: MemoryNamespace,
    input: MemoryWrite,
    signal: AbortSignal,
  ): Promise<MemoryRecord>;
  forget(
    ns: MemoryNamespace,
    id: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  conversationSearch(
    ns: MemoryNamespace,
    query: string,
    signal: AbortSignal,
  ): Promise<ConversationHit[]>;
  export(ns: MemoryNamespace, signal: AbortSignal): Promise<MemoryRecord[]>;
}

// Reject before text reaches an embedding/extraction service or durable memory.
// This is a conservative boundary filter, not a claim of exhaustive DLP.
export function containsSecret(text: string): boolean {
  return /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:sk-(?:or-v1-)?[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16})\b|\bBearer\s+[\w./-]{12,}|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|client[_ -]?secret)\s*[:=]\s*["']?\S{6,}/i.test(
    text,
  );
}
export function assertMemorySafe(text: string): void {
  if (containsSecret(text))
    throw new Error("Sensitive credentials cannot be stored in memory");
}

export interface MemoryPrincipal {
  userId: string;
  conversationId: string;
  // Workers receive a runtime-owned namespace and may never widen it.
  agentId?: string;
  allowedScope?: MemoryScope;
}

export class MemoryGateway {
  constructor(
    readonly provider: MemoryProvider,
    private readonly timeoutMs = 5000,
    private readonly observe?: (event: {
      provider: string;
      operation: string;
      latencyMs: number;
      success: boolean;
    }) => void,
  ) {}

  private async namespace(
    principal: MemoryPrincipal,
    scope: MemoryScope,
  ): Promise<MemoryNamespace> {
    const owner = await getPrismaClient().conversation.findFirst({
      where: { id: principal.conversationId, userId: principal.userId },
      select: { id: true },
    });
    if (!owner) throw new Error("Memory access denied");
    if (principal.allowedScope && principal.allowedScope !== scope)
      throw new Error("Memory scope cannot be widened by an agent");
    if (scope === "agent" && !principal.agentId)
      throw new Error("Agent memory requires a runtime namespace");
    return { ...principal, scope };
  }

  async call<T>(
    principal: MemoryPrincipal,
    scope: MemoryScope,
    operation: string,
    work: (ns: MemoryNamespace, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const started = performance.now();
    const span = tracer.startSpan("memory." + operation, {
      attributes: {
        "memory.provider": this.provider.id,
        "memory.version": this.provider.version,
        "memory.scope": scope,
      },
    });
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let success = false;
    try {
      const stopped = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("Memory operation interrupted or timed out")),
          { once: true },
        );
        timer = setTimeout(abort, this.timeoutMs);
      });
      const operationResult = (async () => {
        controller.signal.throwIfAborted();
        const ns = await this.namespace(principal, scope);
        controller.signal.throwIfAborted();
        return work(ns, controller.signal);
      })();
      const result = await Promise.race([operationResult, stopped]);
      success = true;
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const latencyMs = performance.now() - started;
      span.setAttribute("memory.success", success);
      span.setAttribute("memory.latency_ms", latencyMs);
      span.end();
      try {
        this.observe?.({
          provider: this.provider.id,
          operation,
          latencyMs,
          success,
        });
      } catch {
        /* Telemetry cannot change the outcome. */
      }
    }
  }

  private async visibleRecords(
    ns: MemoryNamespace,
    records: MemoryRecord[],
    activeOnly: boolean,
  ) {
    const owned = new Set(
      (
        await getPrismaClient().conversation.findMany({
          where: {
            userId: ns.userId,
            id: { in: [...new Set(records.map((r) => r.conversationId))] },
          },
          select: { id: true },
        })
      ).map((c) => c.id),
    );
    return records.filter(
      (r) =>
        r.userId === ns.userId &&
        owned.has(r.conversationId) &&
        (ns.scope === "user" || r.conversationId === ns.conversationId) &&
        r.scope === ns.scope &&
        (ns.scope !== "agent" || r.agentId === ns.agentId) &&
        (!activeOnly || r.status === "active") &&
        !containsSecret(r.subject + " " + r.fact),
    );
  }
  search(
    p: MemoryPrincipal,
    scope: MemoryScope,
    query: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      p,
      scope,
      "search",
      async (ns, s) =>
        this.visibleRecords(ns, await this.provider.search(ns, query, s), true),
      signal,
    );
  }
  async remember(
    p: MemoryPrincipal,
    scope: MemoryScope,
    input: MemoryWrite,
    signal?: AbortSignal,
  ) {
    assertMemorySafe(input.subject + " " + input.fact);
    return this.call(
      p,
      scope,
      input.replacesId ? "correct" : "remember",
      async (ns, s) => {
        const source = await getPrismaClient().message.findFirst({
          where: {
            id: input.sourceMessageId,
            conversationId: p.conversationId,
            role: "user",
            conversation: { userId: p.userId },
          },
          select: { id: true },
        });
        if (!source)
          throw new Error("Memory requires an owned user-message source");
        s.throwIfAborted();
        return this.provider.remember(ns, input, s);
      },
      signal,
    );
  }
  forget(
    p: MemoryPrincipal,
    scope: MemoryScope,
    id: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      p,
      scope,
      "forget",
      (ns, s) => this.provider.forget(ns, id, s),
      signal,
    );
  }
  conversationSearch(
    p: MemoryPrincipal,
    scope: MemoryScope,
    query: string,
    signal?: AbortSignal,
  ) {
    return this.call(
      p,
      scope,
      "conversation_search",
      async (ns, s) => {
        const hits = await this.provider.conversationSearch(ns, query, s);
        if (ns.scope === "agent") return [];
        const messages = await getPrismaClient().message.findMany({
          where: {
            id: { in: hits.slice(0, 10).map((h) => h.id) },
            conversation: { userId: ns.userId },
            ...(ns.scope === "conversation"
              ? { conversationId: ns.conversationId }
              : {}),
            role: { in: ["user", "assistant"] },
            status: "complete",
          },
        });
        const byId = new Map(messages.map((m) => [m.id, m]));
        return hits
          .flatMap((h) => {
            const m = byId.get(h.id);
            return m && !containsSecret(m.content)
              ? [
                  {
                    id: m.id,
                    conversationId: m.conversationId,
                    role: m.role,
                    content: m.content.slice(0, 6000),
                    createdAt: m.createdAt.toISOString(),
                  },
                ]
              : [];
          })
          .slice(0, 10);
      },
      signal,
    );
  }
  export(p: MemoryPrincipal, scope: MemoryScope, signal?: AbortSignal) {
    return this.call(
      p,
      scope,
      "export",
      async (ns, s) => ({
        schemaVersion: 1,
        provider: { id: this.provider.id, version: this.provider.version },
        namespace: ns,
        records: await this.visibleRecords(
          ns,
          await this.provider.export(ns, s),
          false,
        ),
      }),
      signal,
    );
  }
}
