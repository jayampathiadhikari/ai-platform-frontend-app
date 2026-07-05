// Public surface of the Deep Agent implementation
//
// The core agent is powered by the official `deepagents` npm package
// (createDeepAgent), which provides built-in task planning (write_todos),
// virtual filesystem, context summarization, subagent delegation, and
// prompt caching.

export { DeepDevAgent } from "./agents/dev-agent.js";

export { checkBashGuard }                from "./guardrails/bash-guard.js";
export { UsageTracker, estimateCostUsd } from "./callbacks/usage-tracker.js";

export { makeBashTool }                        from "./tools/bash.js";
export { makeReadFileTool }                    from "./tools/read-file.js";
export { makeWriteFileTool, makeEditFileTool } from "./tools/write-edit-file.js";
export { makeGlobTool, makeGrepTool }          from "./tools/glob-grep.js";

// Orchestrator — same runJob / buildGraph / GraphState surface as langchain/langchain
export { runJob, buildGraph } from "./orchestrator/index.js";
export type { GraphState }    from "./orchestrator/index.js";
