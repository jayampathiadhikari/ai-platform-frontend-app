// Public surface of the LangChain agent implementation
export { LangChainDevAgent } from "./agents/dev-agent.js";
export { checkBashGuard }    from "./guardrails/bash-guard.js";
export { UsageTracker, estimateCostUsd } from "./callbacks/usage-tracker.js";

// Tools (exported for testing / composition)
export { makeBashTool }                        from "./tools/bash.js";
export { makeReadFileTool }                    from "./tools/read-file.js";
export { makeWriteFileTool, makeEditFileTool } from "./tools/write-edit-file.js";
export { makeGlobTool, makeGrepTool }          from "./tools/glob-grep.js";

// Orchestrator — drop-in replacement for the claude-sdk runJob
export { runJob, buildGraph } from "./orchestrator/index.js";
export type { GraphState }    from "./orchestrator/index.js";
