/** Library entry point — re-exports the Phase 0 foundations. */
export { resolvePaths, ensurePaths } from "./paths.js";
export type { JlcodePaths } from "./paths.js";
export { createLogger, LEVELS } from "./logger.js";
export type { Logger, LogLevel, LoggerOptions, Fields } from "./logger.js";
export { getVersion } from "./version.js";
export { loadConfig, saveConfig, defaultConfig } from "./config/store.js";
export * from "./config/operations.js";
export type {
  Config,
  ModelConfig,
  Mode,
  ApprovalPolicy,
  ReasoningEffort,
  CompactionSettings,
  CompactionTrigger,
  SamplingParams,
} from "./config/types.js";

// Conversation tree + wire assembly
export { newConversation, appendEntry, pathToLeaf, setActiveLeaf, childrenOf } from "./conversation/tree.js";
export { buildWireMessages } from "./conversation/wire.js";
export type { Conversation, Entry } from "./conversation/types.js";

// LLM client, streaming, cache
export { OpenRouterClient } from "./llm/client.js";
export { streamSSE, chunkToEvents, accumulate } from "./llm/stream.js";
export { LlmCache, hashRequest, requestSignature, stableStringify } from "./llm/cache.js";
export type { ChatRequest, ChatMessage, StreamEvent, AssistantResult, LlmDriver } from "./llm/types.js";

// Sessions
export { Session } from "./session/session.js";
export { SessionManager } from "./session/manager.js";
export { scriptedDriver, throwingDriver, echoDriver } from "./session/fake.js";
export type { SessionEvent, SessionStatus } from "./session/types.js";
