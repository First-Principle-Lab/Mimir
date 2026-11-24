import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { getPrismaClient } from "@mimir/backend-core";
import {
  retainToolOutput,
  artifactReadSpec,
} from "../harness/tool-artifacts.js";
import type { ToolSpec } from "../harness/tools.js";
const prisma = getPrismaClient();
const userId = "artifact-test-" + randomUUID(),
  conversationId = randomUUID();
const ctx = { userId, conversationId, runId: "test-run" };
beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: userId + "@example.test", passwordHash: "test" },
  });
  await prisma.conversation.create({ data: { id: conversationId, userId } });
});
afterAll(async () => {
  await prisma.conversation.delete({ where: { id: conversationId } });
  await prisma.user.delete({ where: { id: userId } });
});
test("large untrusted output remains retrievable with its source and tenant boundary", async () => {
  const spec = {
    name: "mail_read",
    resultTrust: "untrusted",
    outputMaxChars: 500,
  } as ToolSpec;
  const text = "x".repeat(2000) + "DISTANT_DETAIL";
  const retained = String(await retainToolOutput(spec, text, ctx));
  const reference = retained.match(/output-[a-f0-9]{64}/)![0];
  expect(retained.length).toBeLessThan(500);
  const page = await artifactReadSpec.execute(
    { reference, offset: 1995, length: 100 },
    ctx,
  );
  expect(JSON.stringify(page)).toContain("DISTANT_DETAIL");
  expect(JSON.stringify(page)).toContain("untrusted_content");
  expect(JSON.stringify(page)).toContain("mail_read");
  await expect(
    artifactReadSpec.execute({ reference }, { ...ctx, userId: "other-user" }),
  ).rejects.toThrow("not found");
  await retainToolOutput(spec, text, ctx);
  expect(await prisma.toolArtifact.count({ where: { conversationId } })).toBe(
    1,
  );
});
