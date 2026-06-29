// Re-export the shared Agent contract so both SDK implementations
// can be swapped without touching orchestrator imports.
export type { Agent, JobResult, ReviewVerdict } from "../claude-sdk/agents/types.js";
