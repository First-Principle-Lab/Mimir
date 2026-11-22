import { getPrismaClient } from "@mimir/backend-core";
import { type McpToolSchema } from "@mimir/tasks";
import { mcpToolTask } from "../integrations/mcp/mcp-task.js";
import { taskToSpec, type ToolRisk, type ToolSpec } from "./tools.js";

// Fixed action metadata, never a model/keyword classifier. The wrapper's name
// cannot make an inner send/read safer; unknown inner actions stay high risk.
const INNER_RISK: Record<string, ToolRisk> = {
  GMAIL_FETCH_EMAILS: "read_private",
  GMAIL_GET_MESSAGE: "read_private",
  GMAIL_SEND_EMAIL: "communicate_external",
  GMAIL_SEND_DRAFT: "communicate_external",
  GMAIL_CREATE_EMAIL_DRAFT: "write_reversible_self",
  GOOGLECALENDAR_LIST_EVENTS: "read_private",
  GOOGLECALENDAR_CREATE_EVENT: "communicate_external",
  GOOGLECALENDAR_UPDATE_EVENT: "communicate_external",
  GOOGLECALENDAR_DELETE_EVENT: "destructive",
  GITHUB_CREATE_AN_ISSUE: "communicate_external",
  GITHUB_CREATE_AN_ISSUE_COMMENT: "communicate_external",
  GITHUB_DELETE_A_REPOSITORY: "destructive",
  NOTION_CREATE_A_PAGE: "communicate_external",
  NOTION_UPDATE_PAGE: "communicate_external",
};
const order: ToolRisk[] = [
  "read_public",
  "read_private",
  "write_reversible_self",
  "communicate_external",
  "destructive",
  "financial_identity",
  "code_exec",
];
export function mcpActionRisk(name: string, raw: unknown): ToolRisk {
  const args = raw as {
    tool_slug?: unknown;
    tools?: { tool_slug?: unknown }[];
  } | null;
  const slugs =
    name === "COMPOSIO_MULTI_EXECUTE_TOOL"
      ? Array.isArray(args?.tools) && args.tools.length
        ? args.tools.map((t) => t?.tool_slug)
        : [undefined]
      : name === "COMPOSIO_EXECUTE_TOOL"
        ? [args?.tool_slug]
        : [name];
  return slugs.reduce<ToolRisk>((highest, slug) => {
    const risk =
      typeof slug === "string"
        ? (INNER_RISK[slug] ?? "code_exec")
        : "code_exec";
    return order.indexOf(risk) > order.indexOf(highest) ? risk : highest;
  }, "read_public");
}
export async function mcpToolsFor(userId: string): Promise<ToolSpec[]> {
  const servers = await getPrismaClient().mcpServer.findMany({
    where: { userId, status: "connected" },
  });
  return servers.flatMap((server) => {
    const schemas = Array.isArray(server.toolSchema)
      ? (server.toolSchema as unknown as McpToolSchema[])
      : [];
    return schemas
      .filter(
        (tool) =>
          typeof tool?.name === "string" &&
          tool.inputSchema &&
          typeof tool.inputSchema === "object",
      )
      .map((tool) => {
        const spec = taskToSpec(mcpToolTask(server.id, tool), {
          risk: "code_exec",
          sideEffect: "irreversible",
          resultTrust: "untrusted",
        });
        spec.idempotent = false;
        spec.deferred = true;
        spec.provenance = "mimir:mcp/" + server.id + "/" + tool.name;
        // All custom MCP invocations require a card, including claimed reads.
        // For Composio meta-tools, compute the card's risk from every inner call.
        spec.effectiveRisk = (raw) => mcpActionRisk(tool.name, raw);
        return spec;
      });
  });
}
