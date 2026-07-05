// Re-export the framework-agnostic bash guard from langchain/langchain.
// Both implementations share the same ruleset to guarantee consistent safety behaviour.
export { checkBashGuard } from "../../langchain/guardrails/bash-guard.js";
export type { GuardResult } from "../../langchain/guardrails/bash-guard.js";
