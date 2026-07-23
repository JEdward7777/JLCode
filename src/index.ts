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
