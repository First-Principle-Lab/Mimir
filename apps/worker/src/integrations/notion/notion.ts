import { getConfig, getPrismaClient } from "@mimir/backend-core";
import { ConnectionError, ProviderError, NOTION_INTEGRATION, composioProvider } from "@mimir/connection-provider";
import { ToolError, type Task } from "@mimir/tasks";
import { z } from "zod";
import { rpc, type RequestFn } from "../http-rpc.js";

const prisma = getPrismaClient();

// Notion search task (5.8), read-only, Composio-backed. Notion used to run on
// Nango (getAccessToken + direct REST); it now rides the same proxyExecute
// transport as gmail/calendar/github so the whole roster shares one error path
// and no token ever reaches this app.

export interface NotionPage {
  id: string;
  title: string;
  url: string;
  lastEditedAt: string | null;
}

interface RawPage {
  id?: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, { title?: { plain_text?: string }[] }>;
}

// Split from the task so the REST layer is unit-testable with a fake transport.
// Notion requires a Notion-Version header on every API call; it rides the
// proxyExecute transport's `in: "header"` params.
export async function fetchNotionPages(request: RequestFn, query: string): Promise<NotionPage[]> {
  const results = await rpc<{ results?: RawPage[] }>(request, "/v1/search", {
    method: "POST",
    headers: { "Notion-Version": "2022-06-28" },
    body: { query: query || undefined, page_size: 20 },
  });
  return (results.results ?? []).map((r) => ({
    id: r.id ?? "",
    title: r.properties?.title?.title?.[0]?.plain_text ?? "",
    url: r.url ?? "",
    lastEditedAt: r.last_edited_time ?? null,
  }));
}

export function notionSearchTask(): Task {
  return {
    kind: "task",
    name: "notion_search",
    description: "Search the user's connected Notion workspace for pages matching a query.",
    inputSchema: z.object({ query: z.string() }),
    execute: async (input, ctx) => {
      const { query } = input as { query: string };
      const cfg = getConfig();
      const webBase = cfg.PUBLIC_API_URL ?? cfg.WEB_APP_URL ?? "";
      const provider = composioProvider(NOTION_INTEGRATION, cfg, prisma.integrationConnection, `${webBase}/api/v1/integrations/notion/callback`);
      const request: RequestFn = (path, opts) => provider.apiRequest(ctx.userId, path, opts);
      try {
        return { provider: "notion", pages: await fetchNotionPages(request, query) };
      } catch (e) {
        if (e instanceof ConnectionError) throw new ToolError("connection", e.message);
        if (e instanceof ProviderError) throw new ToolError("execution", e.message);
        throw e;
      }
    },
  };
}