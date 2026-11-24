import { createHash } from "node:crypto";
import {
  getPrismaClient,
  HARNESS_TOOL_OUTPUT_MAX_CHARS,
} from "@mimir/backend-core";
import { z } from "zod";
import {
  renderToolResult,
  type ToolRunContext,
  type ToolSpec,
} from "./tools.js";

const prisma = getPrismaClient();
export async function retainToolOutput(
  spec: ToolSpec,
  value: unknown,
  ctx: ToolRunContext,
): Promise<unknown> {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const max = spec.outputMaxChars;
  if (!text || text.length <= max || !ctx.runId) return value;
  await ctx.assertOwned?.();
  const owner = await prisma.conversation.findFirst({
    where: { id: ctx.conversationId, userId: ctx.userId },
    select: { id: true },
  });
  if (!owner) throw new Error("Tool output access denied");
  const id =
    "output-" +
    createHash("sha256")
      .update(
        ctx.userId +
          ":" +
          ctx.conversationId +
          ":" +
          spec.name +
          ":" +
          spec.resultTrust +
          ":" +
          text,
      )
      .digest("hex");
  // Bound storage too; report that cap explicitly. No unbounded provider blobs.
  const stored = text.slice(0, 1_000_000);
  await prisma.toolArtifact.upsert({
    where: { id },
    create: {
      id,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      toolName: spec.name,
      trust: spec.resultTrust,
      content: stored,
    },
    update: {},
  });
  return (
    `Full output reference: ${id}. Read with tool_output_read(reference, offset, length). Stored ${stored.length} of ${text.length} characters.\n` +
    text.slice(0, Math.max(0, max - 300))
  );
}
const input = z.object({
  reference: z.string().startsWith("output-"),
  offset: z.number().int().min(0).default(0),
  length: z.number().int().min(1).max(6000).default(4000),
});
export const artifactReadSpec: ToolSpec = {
  name: "tool_output_read",
  label: "Read stored tool output",
  description:
    "Read a bounded page of a large tool result using its output reference. Offset and length count characters. The original source and trust label are preserved.",
  parameters: z.toJSONSchema(input, { io: "input" }),
  risk: "read_private",
  sideEffect: "none",
  idempotent: true,
  provenance: "mimir:tool-output",
  resultTrust: "untrusted",
  outputMaxChars: HARNESS_TOOL_OUTPUT_MAX_CHARS,
  deferred: true,
  execute: async (args, ctx) => {
    const a = input.parse(args);
    const row = await prisma.toolArtifact.findFirst({
      where: {
        id: a.reference,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        conversation: { userId: ctx.userId },
      },
    });
    if (!row) throw new Error("Stored output not found in this conversation");
    return {
      reference: row.id,
      offset: a.offset,
      nextOffset: Math.min(a.offset + a.length, row.content.length),
      totalCharacters: row.content.length,
      content: renderToolResult(
        {
          name: row.toolName,
          resultTrust: row.trust === "untrusted" ? "untrusted" : "trusted",
          outputMaxChars: a.length,
        },
        row.content.slice(a.offset, a.offset + a.length),
      ),
    };
  },
};
