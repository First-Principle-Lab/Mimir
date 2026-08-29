import { getPrismaClient } from "@mimir/backend-core";
import { GITHUB_INTEGRATION, GMAIL_INTEGRATION, GOOGLE_CALENDAR_INTEGRATION, NOTION_INTEGRATION } from "@mimir/connection-provider";
import type { McpToolSchema, Task } from "@mimir/tasks";
import { browserFetchTask } from "../integrations/browser/browser-task.js";
import { calendarGetEventTask, calendarListEventsTask } from "../integrations/calendar/calendar.js";
import { githubGetIssueTask, githubListIssuesTask, githubListPullRequestsTask } from "../integrations/github/github.js";
import { gmailSearchTask } from "../integrations/gmail/gmail.js";
import { mcpToolTask } from "../integrations/mcp/mcp-task.js";
import { notionSearchTask } from "../integrations/notion/notion.js";
import { triggerTools } from "./trigger-tools.js";

const prisma = getPrismaClient();

// The per-user task roster: what the execution agent can invoke beyond the
// system tools (wait/draft). browser is always available; the connected
// integrations (gmail/calendar/github/notion) each expose their read tasks when
// the user has a connection row; registered MCP servers expose each of their
// tools as a dynamic Task. trigger CRUD is always available and scoped to the
// calling agent, EXCEPT for one-shot runs (executeOnce) which have no agent to
// scope to — pass includeTriggerTools: false there. The LLM sees the union via
// toLlmTool.
export async function agentTasksFor(
  userId: string,
  opts: { includeTriggerTools?: boolean } = {},
): Promise<Task[]> {
  const tasks: Task[] = [browserFetchTask()];
  if (opts.includeTriggerTools !== false) tasks.push(...triggerTools());

  const connections = await prisma.integrationConnection.findMany({
    where: { userId, status: "connected" },
    select: { provider: true },
  });
  const connected = new Set(connections.map((c) => c.provider));

  // Integration read tasks follow the plan's Tools/Tasks split (4.9) —
  // calendar/github/notion each gate on their own connection row. Writes stay
  // out of v1 (they'd need the confirmation gate).
  if (connected.has(GMAIL_INTEGRATION)) tasks.push(gmailSearchTask());
  if (connected.has(GOOGLE_CALENDAR_INTEGRATION)) {
    tasks.push(calendarListEventsTask(), calendarGetEventTask());
  }
  if (connected.has(GITHUB_INTEGRATION)) {
    tasks.push(githubListIssuesTask(), githubGetIssueTask(), githubListPullRequestsTask());
  }
  if (connected.has(NOTION_INTEGRATION)) tasks.push(notionSearchTask());

  const servers = await prisma.mcpServer.findMany({ where: { userId, status: "connected" } });
  for (const server of servers) {
    const tools = (server.toolSchema ?? []) as unknown as McpToolSchema[];
    for (const tool of tools) {
      tasks.push(mcpToolTask(server.id, tool));
    }
  }
  return tasks;
}
