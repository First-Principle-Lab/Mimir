export const version = "0.1.0";

import "./observability.js"; // side effect: starts OTel SDK + Sentry before instrumented modules load

export type { User, Message, Conversation } from "@mimir/shared-types";
export * from "./constants.js";
export { getConfig } from "./config/config.js";
export type { Config } from "./config/config.schema.js";
export { getPrismaClient, createPrismaClient, Prisma } from "./prisma.js";
export { withUserScope, currentDbUser, rlsRoleStatements } from "./db-scope.js";
export type { InputJsonValue } from "./prisma.js";
export { tracer, signalUrl } from "./observability.js";
export * from "./metrics.js";
export * from "./budget.js";
export { logger, getLogger, runWithContext } from "./logger.js";
export { callOpenRouter, callEmbeddings, llmConfigFor, modelFor, fetchGenerationCost, NotConfiguredError, OpenRouterError, toWireMessages } from "./openrouter.js";
export type { LlmUseCaseConfig, LlmTool, ToolCall, ToolChoice, LlmCallOptions } from "./openrouter.js";
export { trackEvent } from "./analytics.js";
export { trackModelCall, backfillCost, rollDailyUsage } from "./usage.js";
export { searchActiveFacts, searchActiveFactsWithRelations } from "./facts.js";
export type { FactHit } from "./facts.js";
export {
  loadPrompt,
  interactionSystemPrompt,
  workerSystemPrompt,
} from "./prompts.js";
export * from "./inbox.js";
export * from "./agents.js";
export * from "./notification-policy.js";
export * from "./visible-content.js";
export * from "./memory.js";
export * from "./legacy-memory.js";
