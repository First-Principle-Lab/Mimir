import {
  createToolSearchExtension,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { HARNESS_TOOL_OUTPUT_MAX_CHARS } from "@mimir/backend-core";
import {
  describeToolError,
  isReadOnly,
  renderToolResult,
  type ToolRunContext,
  type ToolSpec,
} from "./tools.js";

import { decideAction, invokeTool } from "./actions.js";

export interface MimirExtensionOptions {
  specs: ToolSpec[];
  ctx: ToolRunContext;
  // Rebuilt per model call so the time stays current across a long run.
  runtimeContext: () => string;
  generation?: { maxOutputTokens: number; temperature: number };
}

// The Mimir harness as one inline pi extension: Mimir's tools, the policy gate,
// and runtime-context injection. Loaded through the session's ResourceLoader;
// nothing is discovered from disk.
export function mimirExtension(
  opts: MimirExtensionOptions,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const specs = [...opts.specs];
    // Adapt the pinned SDK discovery implementation into a ToolSpec too. Its
    // execute function takes only id/arguments and closes over pi's registry;
    // it neither calls tools nor accesses an account or filesystem.
    createToolSearchExtension()({
      ...pi,
      registerTool: (definition) => {
        const discover = definition.execute as unknown as (
          id: string,
          args: unknown,
        ) => Promise<{ content: { type: string; text?: string }[] }>;
        specs.push({
          name: definition.name,
          label: definition.label,
          description: definition.description,
          parameters: definition.parameters as Record<string, unknown>,
          risk: "read_public",
          sideEffect: "none",
          idempotent: true,
          provenance: "pi:tool-search@1.6.0",
          // Custom server descriptions are also untrusted MCP content.
          resultTrust: opts.specs.some((s) =>
            s.provenance.startsWith("mimir:mcp/"),
          )
            ? "untrusted"
            : "trusted",
          outputMaxChars: HARNESS_TOOL_OUTPUT_MAX_CHARS,
          execute: async (args) =>
            (await discover("discovery", args)).content
              .map((block) => block.text ?? "")
              .join("\n"),
        });
      },
    });
    const byName = new Map(specs.map((s) => [s.name, s]));

    for (const spec of specs) {
      pi.registerTool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters as never,
        exposure: spec.deferred ? "deferred" : "direct",
        defaultActive: !spec.deferred,
        execute: async (toolCallId, params, signal) => {
          let onAbort: (() => void) | undefined;
          try {
            signal?.throwIfAborted();
            const aborted = new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(new Error("Tool execution interrupted"));
              if (signal?.aborted) onAbort();
              else signal?.addEventListener("abort", onAbort, { once: true });
            });
            const value = await Promise.race([
              invokeTool(spec, params, { ...opts.ctx, toolCallId, signal }),
              aborted,
            ]);
            return {
              content: [{ type: "text", text: renderToolResult(spec, value) }],
              details: {},
            };
          } catch (e) {
            return {
              content: [
                {
                  type: "text",
                  text: renderToolResult(spec, describeToolError(spec, e)),
                },
              ],
              details: {},
              isError: true,
            };
          } finally {
            if (onAbort) signal?.removeEventListener("abort", onAbort);
          }
        },
      });
    }

    // The fixed tier gate resolves inner actions before execution. The same
    // decision is enforced again by invokeTool, including restored approvals.
    pi.on("tool_call", async (event) => {
      const spec = byName.get(event.toolName);
      if (!spec)
        return { block: true, reason: "Unknown tool: " + event.toolName };
      if (!isReadOnly(spec) && !opts.ctx.runId)
        return { block: true, reason: "A mutation requires a journaled run" };
      try {
        const policy = decideAction(spec, event.input, opts.ctx);
        if (policy.decision === "block")
          return { block: true, reason: policy.reason };
        // Approvals are materialized by the executor with normalized arguments.
        return undefined;
      } catch {
        return {
          block: true,
          reason: "Invalid inner action; no action was executed",
        };
      }
    });

    // The pinned OpenRouter provider uses the OpenAI chat payload. Keep the
    // deployment's generation limits when embedding pi instead of its CLI.
    pi.on("before_provider_request", async (event) => {
      if (!opts.generation) return;
      return {
        ...(event.payload as Record<string, unknown>),
        max_tokens: opts.generation.maxOutputTokens,
        temperature: opts.generation.temperature,
      };
    });

    // Runtime context goes right before the latest user message on every model
    // call. Returning a new list doesn't touch the stored session, so the
    // transcript never fills up with stale timestamps.
    pi.on("context", async (event) => {
      const messages = [...event.messages];
      let at = messages.length;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          at = i;
          break;
        }
      }
      messages.splice(at, 0, {
        role: "user",
        content: [{ type: "text", text: opts.runtimeContext() }],
        timestamp: Date.now(),
      } as (typeof messages)[number]);
      return { messages };
    });
  };
}
