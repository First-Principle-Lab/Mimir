import { readToolsFor } from "./tools.js";
import { writeToolsFor } from "./write-tools.js";
import { mcpToolsFor } from "./mcp-tools.js";
export async function toolsFor(userId: string) {
  const groups = await Promise.all([
    readToolsFor(userId),
    writeToolsFor(userId),
    mcpToolsFor(userId),
  ]);
  return groups.flat();
}
