import { readFileSync } from "node:fs";

// Prompt files are read from disk at runtime (same pattern as model-config.json)
// so they can be edited without a rebuild. They live in
// packages/backend-core/src/prompts so the worker (harness) and the scripts can
// read them, and `turbo prune` keeps them in each app's Docker image.

const PROMPTS_DIR = new URL("./prompts/", import.meta.url);

const fileCache = new Map<string, string>();

export function loadPrompt(name: string): string {
  let text = fileCache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(name, PROMPTS_DIR), "utf8");
    fileCache.set(name, text);
  }
  return text;
}

// The interaction agent's system prompt. Static on purpose — no timestamps or
// per-user data — so the provider can cache it; volatile facts go in the
// per-turn runtime context instead.
export function interactionSystemPrompt(): string {
  return loadPrompt("interaction.md");
}

// Background and delegated agents share one static worker prompt; the agent
// definition's own instructions are appended after it.
export function workerSystemPrompt(): string {
  return loadPrompt("worker.md");
}
