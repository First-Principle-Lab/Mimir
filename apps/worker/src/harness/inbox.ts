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
          return (
            `A background agent you started finished with runtime status ${p.status}. Its report and any proposed actions follow. Decide whether the user needs it: use send_to_user with task_completed for requested work. Proposed actions have not run; request one only through the real tool, where approval applies.\n` +
            renderToolResult({ name: "agent_result", resultTrust: "untrusted" }, p)
          );
        case "event":
        case "routine_fire":
          return `Routine wake. Read this exact observation with channel_read:\n${JSON.stringify({ routineId: p.routineId, key: p.key })}\nUser's saved instruction: ${p.instruction}\nNothing new or relevant means NO_REPLY.`;
        case "approval_answer":
          return "An approval decision arrived. The runtime validates the card and executes its exact stored action before continuing.";
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
