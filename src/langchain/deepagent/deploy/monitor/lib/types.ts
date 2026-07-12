// Shared types for the DeepAgent Monitor UI

export type LogSource = "deepagent-agent" | "deepagent-executor";

export type LogLevel = "info" | "warn" | "error" | "success" | "debug";

export type ComponentTag =
  | "deep:orchestrator"
  | "deep:resolveTicket"
  | "deep:setupWorkspace"
  | "deep:devAgent"
  | "deep:reviewAgent"
  | "deep:postProcess"
  | "deep:teardown"
  | "workspace"
  | "workspace-helpers"
  | "deepagent"
  | "deepagent:bash"
  | "github"
  | "job-registry"
  | "executor"
  | "server"
  | "POST /run/deepagent"
  | string;

export type BashActionType =
  | "WRITE"
  | "INSTALL"
  | "READ"
  | "GIT:STATUS"
  | "GIT:STAGE"
  | "GIT:COMMIT/PUSH"
  | "GIT:COMMIT"
  | "GIT:PUSH"
  | string;

export type AgentBlock = "thinking" | "plan" | "response";

export interface ParsedLogEntry {
  id: string;
  timestamp: string; // ISO string
  source: LogSource;
  rawLine: string;

  // Parsed fields
  component: ComponentTag | null;
  jobId: string | null;
  level: LogLevel;
  message: string;

  // Bash-specific (deepagent:bash lines)
  bashAction?: BashActionType;
  bashDirection?: "→" | "←"; // → = command sent, ← = output received

  // Agent block (thinking / plan / response box header)
  agentBlock?: AgentBlock;

  // Exit code hint
  exitCode?: number;
}

export interface JobGroup {
  jobId: string;
  jiraId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  verdict?: "PASS" | "FAIL" | "PARTIAL";
  prUrl?: string;
  entries: ParsedLogEntry[];
}
