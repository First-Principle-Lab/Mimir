import {
  compactionSettings,
  prepareSessionContext,
  routingSessionId,
} from "./context-policy.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compact,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type SessionEntry,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getConfig,
  interactionSystemPrompt,
  llmConfigFor,
  trackModelCall,
} from "@mimir/backend-core";
import { mimirExtension, type MimirExtensionOptions } from "./extension.js";

// pi is embedded headless: no files are discovered or written. pi wants a
// working directory and an agent dir; both point at a private temp dir that
// holds nothing but pi's own model cache. Sessions are in-memory and hydrated
// from Postgres (SessionEntry) by the caller.
const piDir = mkdtempSync(join(tmpdir(), "mimir-pi-"));

let runtime: Promise<ModelRuntime> | null = null;

function modelRuntime(): Promise<ModelRuntime> {
  if (!runtime) {
    runtime = (async () => {
      const mr = await ModelRuntime.create({
        authPath: join(piDir, "auth.json"),
        modelsPath: join(piDir, "models.json"),
      });
      const key = getConfig().OPENROUTER_API_KEY;
      if (key) await mr.setRuntimeApiKey("openrouter", key);
      return mr;
    })();
  }
  return runtime;
}

// The interaction model comes from model-config.json ("interaction"), falling
// back to "chat_response" for configs that predate the harness.
export function interactionConfig(): ReturnType<typeof llmConfigFor> {
  try {
    return llmConfigFor("interaction");
  } catch {
    return llmConfigFor("chat_response");
  }
}

export function interactionModelId(): string {
  return interactionConfig().model;
}

// A background agent's definition names its model-config.json role
// ("subagent" by default), so leaf workers can run on a cheaper model than
// the interaction agent. Unknown roles fall back to the interaction model.
export function agentConfig(
  role = "subagent",
): ReturnType<typeof llmConfigFor> {
  try {
    return llmConfigFor(role);
  } catch {
    return interactionConfig();
  }
}

export class ModelNotAvailableError extends Error {
  constructor(modelId: string) {
    super(`Model "${modelId}" is not available through OpenRouter`);
    this.name = "ModelNotAvailableError";
  }
}

export interface OpenSessionOptions extends MimirExtensionOptions {
  entries: SessionEntry[];
  history?: { role: string; content: string; createdAt: Date }[];
  modelId?: string;
  uiContext?: ExtensionUIContext;
  // Defaults to the interaction agent's prompt and model settings.
  systemPrompt?: string;
  // Recheck cancellation/budgets after pre-prompt compaction, which can itself
  // consume a model call and exhaust the caller's remaining budget.
  assertCanPrompt?: () => void;
  // Runs before every provider call, including continuation and compaction.
  beforeModelCall?: () => Promise<void>;
  onCompactionUsage?: (usage: {
    input: number;
    output: number;
    cost: { total: number };
  }) => void;
}

// Tests swap in pi's scripted faux provider so the whole harness runs in CI
// without an API key or network.
let modelOverride: { modelRuntime: ModelRuntime; model: Model<Api> } | null =
  null;

export function setModelOverrideForTests(
  override: { modelRuntime: ModelRuntime; model: Model<Api> } | null,
): void {
  modelOverride = override;
}

export async function openSession(
  opts: OpenSessionOptions,
): Promise<AgentSession> {
  const mr = modelOverride?.modelRuntime ?? (await modelRuntime());
  const modelId = opts.modelId ?? interactionModelId();
  const selected = modelOverride?.model ?? mr.getModel("openrouter", modelId);
  const config =
    opts.generation && "maxInputTokens" in opts.generation
      ? (opts.generation as ReturnType<typeof llmConfigFor>)
      : interactionConfig();
  const model = selected
    ? {
        ...selected,
        contextWindow: Math.min(
          selected.contextWindow,
          opts.contextWindow ?? config.maxInputTokens + config.maxOutputTokens,
        ),
      }
    : undefined;
  if (!model) throw new ModelNotAvailableError(modelId);

  const systemPrompt = opts.systemPrompt ?? interactionSystemPrompt();
  const sessionManager = SessionManager.inMemory(
    piDir,
    undefined,
    opts.entries,
  );
  // Existing v1 chats have messages but no pi journal. Seed their recent text
  // once, preserving it as native roles rather than concatenated instructions.
  if (opts.entries.length === 0)
    for (const message of opts.history ?? []) {
      const content = [{ type: "text" as const, text: message.content }];
      const timestamp = message.createdAt.getTime();
      if (message.role === "user")
        sessionManager.appendMessage({ role: "user", content, timestamp });
      else if (message.role === "assistant")
        sessionManager.appendMessage({
          role: "assistant",
          content,
          timestamp,
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: "stop",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        });
    }
  const resourceLoader = new DefaultResourceLoader({
    cwd: piDir,
    agentDir: piDir,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
    extensionFactories: [
      mimirExtension({
        ...opts,
        sessionManager,
        summarize: async (event) => {
          const started = performance.now();
          const result = await compact(
            event.preparation,
            { ...selected!, maxTokens: Math.min(selected!.maxTokens, 4096) },
            (await mr.getAuth(selected!))?.auth.apiKey,
            undefined,
            event.customInstructions ??
              "Preserve user goals, corrections, exact identifiers, source references and unfinished work; retain the provenance of tool data.",
            event.signal,
            "off",
            session.agent.streamFunction,
            undefined,
            undefined,
            undefined,
            routingSessionId(opts.ctx.userId, opts.ctx.conversationId),
          );
          if (result.usage)
            await trackModelCall({
              userId: opts.ctx.userId,
              useCase: "compaction",
              result: {
                content: "",
                model: selected!.id,
                latencyMs: performance.now() - started,
                usage: {
                  promptTokens: result.usage.input,
                  completionTokens: result.usage.output,
                  totalTokens: result.usage.totalTokens,
                },
                cachedTokens: result.usage.cacheRead,
              },
              costUsd: result.usage.cost.total,
            });
          if (result.usage) opts.onCompactionUsage?.(result.usage);
          return result;
        },
        contextWindow: model.contextWindow,
        generation: opts.generation ?? interactionConfig(),
      }),
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: piDir,
    agentDir: piDir,
    model,
    thinkingLevel: "off",
    modelRuntime: mr,
    resourceLoader,
    // Native pi checkpoints preserve original entries and survive hydration.
    settingsManager: SettingsManager.inMemory({
      compaction: compactionSettings(model.contextWindow),
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager,
    noTools: "builtin",
  });
  await session.bindExtensions({ uiContext: opts.uiContext });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = async (...args) => {
    await opts.beforeModelCall?.();
    return stream(...args);
  };
  session.setActiveToolsByName([
    ...opts.specs.filter((s) => !s.deferred).map((s) => s.name),
    "tool_search",
  ]);
  const prompt = session.prompt.bind(session);
  session.prompt = async (text, options) => {
    await prepareSessionContext(session, model.contextWindow, text);
    opts.assertCanPrompt?.();
    return prompt(text, options);
  };
  return session;
}
