import Browserbase from "@browserbasehq/sdk";
import puppeteer from "puppeteer-core";
import { getConfig } from "@mimir/backend-core";
import { ToolError } from "@mimir/tasks";
import { z } from "zod";
import { assertAllowedUrl } from "./browser-task.js";
import {
  browserBudgetCheck,
  recordBrowserMinutes,
} from "../../infra/budget.js";
import type { ToolSpec } from "../../harness/tools.js";

const schema = z.strictObject({
  url: z.url(),
  fields: z
    .array(
      z.strictObject({
        selector: z.string().min(1).max(1000),
        value: z.string().max(8000),
      }),
    )
    .max(20),
  submitSelector: z.string().min(1).max(1000),
});
export type BrowserSubmission = z.infer<typeof schema>;
export type SubmitRuntime = (
  args: BrowserSubmission,
  signal?: AbortSignal,
) => Promise<unknown>;
const submit: SubmitRuntime = async (args, signal) => {
  const cfg = getConfig();
  if (!cfg.BROWSERBASE_API_KEY)
    throw new ToolError("connection", "Browser is not configured");
  signal?.throwIfAborted();
  const client = new Browserbase({ apiKey: cfg.BROWSERBASE_API_KEY });
  const session = await client.sessions.create({
    projectId: cfg.BROWSERBASE_PROJECT_ID,
  });
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: session.connectUrl,
    });
    const page = await browser.newPage();
    await page.goto(args.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const initial = new URL(args.url);
    // Nothing has been submitted yet, so these refusals change nothing.
    if (new URL(page.url()).origin !== initial.origin)
      throw new ToolError(
        "validation",
        "The page redirected to a different origin; review a new action",
      );
    for (const field of args.fields) {
      signal?.throwIfAborted();
      await page.locator(field.selector).fill(field.value);
    }
    signal?.throwIfAborted();
    if (new URL(page.url()).origin !== initial.origin)
      throw new ToolError(
        "validation",
        "The page changed origin before submission",
      );
    await page.locator(args.submitSelector).click();
    return { submitted: true, url: page.url(), title: await page.title() };
  } finally {
    await browser?.close().catch(() => {});
    await client.sessions
      .update(session.id, { status: "REQUEST_RELEASE" })
      .catch(() => {});
  }
};
export function browserSubmitSpec(runtime: SubmitRuntime = submit): ToolSpec {
  return {
    name: "browser_submit",
    label: "Submit web form",
    description:
      "Fill the exact listed fields and click one submit control in an isolated hosted browser. Always requires approval of the URL, field values and submit selector. Do not use for payments, purchases, credentials or identity changes.",
    parameters: schema.toJSONSchema(),
    risk: "communicate_external",
    sideEffect: "irreversible",
    idempotent: false,
    provenance: "mimir:write/browser_submit@1",
    resultTrust: "untrusted",
    outputMaxChars: 8000,
    deferred: true,
    prepare: (raw) => {
      const args = schema.parse(raw);
      assertAllowedUrl(args.url);
      return args;
    },
    execute: async (raw, ctx) => {
      const args = schema.parse(raw);
      assertAllowedUrl(args.url);
      if (!(await browserBudgetCheck(ctx.userId)))
        throw new ToolError("blocked", "Daily browser budget exhausted");
      const start = Date.now();
      try {
        return await runtime(args, ctx.signal);
      } finally {
        await recordBrowserMinutes(ctx.userId, (Date.now() - start) / 60000);
      }
    },
  };
}
