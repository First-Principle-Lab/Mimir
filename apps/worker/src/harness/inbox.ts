import {
  getPrismaClient,
  inboxPayload,
  type InboxPayload,
  type Prisma,
} from "@mimir/backend-core";
import { renderToolResult } from "./tools.js";

const prisma = getPrismaClient();
export type Input = Prisma.InboxInput;
export function pendingInputs(conversationId: string): Promise<Input[]> {
  return prisma.inboxInput.findMany({
    where: { conversationId, status: { in: ["pending", "running"] } },
    orderBy: { seq: "asc" },
    take: 64,
  });
}
export function payloadOf(input: Input): InboxPayload {
  return inboxPayload.parse(input.payload);
}
export function isStop(input: Input): boolean {
  const p = payloadOf(input);
  return p.kind === "user" && p.control === "stop";
}
export function inputText(inputs: Input[]): string {
  return inputs
    .map((input) => {
      const p = payloadOf(input);
      switch (p.kind) {
        case "user":
          return p.text;
        case "agent_result":
          return renderToolResult(
            { name: "agent_result", resultTrust: "untrusted" },
            p,
          );
        case "event":
        case "routine_fire":
          return `Routine ${p.routineId}; occurrence ${p.key}. User's saved instruction: ${p.instruction}\nUse channel_read to inspect this occurrence before deciding whether to notify. Nothing new or relevant means NO_REPLY.`;
        case "approval_answer":
          return "An approval answer arrived. External writes and approval resumption are not enabled yet. Do not execute an action.";
      }
    })
    .join("\n\n");
}
export async function claimInputs(
  inputs: Input[],
  runId: string,
): Promise<void> {
  await prisma.inboxInput.updateMany({
    where: { id: { in: inputs.map((i) => i.id) } },
    data: { status: "running", runId },
  });
}
