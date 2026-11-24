import { getPrismaClient } from "./prisma.js";
import { callEmbeddings } from "./openrouter.js";
import { searchActiveFactsWithRelations } from "./facts.js";
import {
  MemoryGateway,
  type MemoryNamespace,
  type MemoryProvider,
  type MemoryRecord,
  type MemoryWrite,
  type MemoryScope,
} from "./memory.js";

const prisma = getPrismaClient();
function where(ns: MemoryNamespace) {
  return {
    userId: ns.userId,
    memoryScope: ns.scope,
    ...(ns.scope === "user" ? {} : { conversationId: ns.conversationId }),
    memoryAgentId: ns.scope === "agent" ? ns.agentId! : null,
    conversation: { userId: ns.userId },
  };
}
function record(row: {
  userId: string;
  id: string;
  subject: string;
  fact: string;
  sourceMessageId: string | null;
  conversationId: string;
  memoryScope: string;
  memoryAgentId: string | null;
  status: string;
  createdAt: Date;
  supersedesId: string | null;
}): MemoryRecord {
  return {
    userId: row.userId,
    id: row.id,
    subject: row.subject,
    fact: row.fact,
    sourceMessageId: row.sourceMessageId,
    conversationId: row.conversationId,
    scope: row.memoryScope as MemoryScope,
    agentId: row.memoryAgentId ?? undefined,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    supersedesId: row.supersedesId,
  };
}

// Compatibility adapter only: reuses the existing fact retriever and tables.
// No new extraction, ranking, graph or embedding strategy is introduced here.
export class LegacyMemoryProvider implements MemoryProvider {
  constructor(private readonly embed = callEmbeddings) {}
  readonly id = "legacy-pgvector";
  readonly version = "1";
  async search(ns: MemoryNamespace, query: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const hits = await searchActiveFactsWithRelations(
      ns.conversationId,
      query,
      { namespace: ns, embed: this.embed },
    );
    signal.throwIfAborted();
    const rows = await prisma.extractedFact.findMany({
      where: {
        ...where(ns),
        status: "active",
        id: { in: hits.map((h) => h.id) },
      },
    });
    const order = new Map(hits.map((h, i) => [h.id, i]));
    return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!).map(record);
  }
  async remember(ns: MemoryNamespace, input: MemoryWrite, signal: AbortSignal) {
    signal.throwIfAborted();
    // Embedding failures leave a lexical-searchable fact, matching legacy extraction.
    const vector = await this.embed(input.fact).catch(() => null);
    signal.throwIfAborted();
    return prisma.$transaction(async (tx) => {
      if (input.replacesId) {
        const changed = await tx.extractedFact.updateMany({
          where: { ...where(ns), id: input.replacesId, status: "active" },
          data: { status: "superseded" },
        });
        if (changed.count !== 1)
          throw new Error(
            "Active memory to correct was not found in this scope",
          );
      }
      signal.throwIfAborted();
      const row = await tx.extractedFact.create({
        data: {
          userId: ns.userId,
          conversationId: ns.conversationId,
          memoryScope: ns.scope,
          memoryAgentId: ns.scope === "agent" ? ns.agentId : null,
          subject: input.subject,
          fact: input.fact,
          sourceMessageId: input.sourceMessageId,
          supersedesId: input.replacesId,
        },
      });
      if (vector?.length === 1536)
        await tx.$executeRaw`UPDATE "ExtractedFact" SET embedding = ${`[${vector.join(",")}]`}::vector WHERE id = ${row.id}`;
      signal.throwIfAborted();
      return record(row);
    });
  }
  async forget(ns: MemoryNamespace, id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const result = await prisma.extractedFact.updateMany({
      where: { ...where(ns), id, status: { not: "deleted" } },
      data: {
        status: "deleted",
        deletedAt: new Date(),
        deletedReason: "user_requested",
      },
    });
    return result.count > 0;
  }
  async conversationSearch(
    ns: MemoryNamespace,
    query: string,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // Agent-local memory cannot read the parent's private transcript.
    if (ns.scope === "agent") return [];
    const terms = query.trim().split(/\s+/).filter(Boolean).slice(0, 12);
    if (!terms.length) return [];
    const rows = await prisma.message.findMany({
      where: {
        conversation: { userId: ns.userId },
        ...(ns.scope === "conversation"
          ? { conversationId: ns.conversationId }
          : {}),
        role: { in: ["user", "assistant"] },
        status: "complete",
        AND: terms.map((term) => ({
          content: { contains: term, mode: "insensitive" as const },
        })),
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role,
      content: r.content.slice(0, 6000),
      createdAt: r.createdAt.toISOString(),
    }));
  }
  async export(ns: MemoryNamespace, signal: AbortSignal) {
    signal.throwIfAborted();
    // Include tombstones and supersession links so migration cannot revive deletions.
    return (
      await prisma.extractedFact.findMany({
        where: where(ns),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    ).map(record);
  }
}

let gateway = new MemoryGateway(new LegacyMemoryProvider());
export function memoryGateway(): MemoryGateway {
  return gateway;
}
// Explicit process composition only; never load provider code/config from user files.
export function configureMemoryProvider(
  provider: MemoryProvider,
  timeoutMs = 5000,
): void {
  gateway = new MemoryGateway(provider, timeoutMs);
}
