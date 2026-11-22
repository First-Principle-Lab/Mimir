import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
export function interactionModelId(): string {
  try {
    return llmConfigFor("interaction").model;
  } catch {
    return llmConfigFor("chat_response").model;
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
  const model = modelOverride?.model ?? mr.getModel("openrouter", modelId);
  if (!model) throw new ModelNotAvailableError(modelId);

  const systemPrompt = interactionSystemPrompt();
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
    extensionFactories: [mimirExtension(opts)],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: piDir,
    agentDir: piDir,
    model,
    thinkingLevel: "off",
    modelRuntime: mr,
    resourceLoader,
    // Compaction stays off until Phase 5 designs it around the prompt cache.
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    }),
    sessionManager,
    noTools: "builtin",
  });
  await session.bindExtensions({ uiContext: opts.uiContext });
  session.setActiveToolsByName([
    ...opts.specs.filter((s) => !s.deferred).map((s) => s.name),
    "tool_search",
  ]);
  return session;
}
