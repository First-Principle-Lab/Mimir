import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { loadEnv } from "./_env.js";
loadEnv();
const [userId, conversationId, scope = "conversation"] = process.argv.slice(2);
if (!userId || !conversationId || !["conversation", "user"].includes(scope)) {
  console.error(
    "Usage: bun scripts/export-memory.ts <owner-id> <conversation-id> [conversation|user]",
  );
  process.exit(64);
}
const { memoryGateway, getPrismaClient } =
  await import("../packages/backend-core/src/index.js");
try {
  const snapshot = await memoryGateway().export(
    { userId, conversationId },
    scope as "conversation" | "user",
  );
  const directory = resolve("results/private-memory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const name = createHash("sha256")
    .update(userId + conversationId + Date.now())
    .digest("hex")
    .slice(0, 20);
  const output = resolve(directory, name + ".json");
  writeFileSync(output, JSON.stringify(snapshot, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log("Private migration snapshot written to " + output);
} finally {
  await getPrismaClient().$disconnect();
}
