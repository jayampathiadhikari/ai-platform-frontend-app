import type { ParsedLogEntry, LogSource, ComponentTag, LogLevel, BashActionType, AgentBlock } from "./types";

// ─── Regex patterns ───────────────────────────────────────────────────────────

// Matches: [component] [jobId] message   OR   [component] message
const COMPONENT_RE = /^\[([^\]]+)\](?:\s+\[([a-zA-Z0-9-]+)\])?\s+(.*)/s;

// Matches deepagent bash lines: [deepagent:bash] [ACTION] → command  OR  ← output
const BASH_ACTION_RE = /^\[([A-Z:\/]+)\]\s+(→|←)\s+(.*)/s;

// Structured agent block lines (flat, single-line format):
//   [deepagent:thinking] [jobId] ...
//   [deepagent:plan] [jobId] ...
//   [deepagent:response] [jobId] ...
const AGENT_BLOCK_RE = /^\[(deepagent):(thinking|plan|response)\](?:\s+\[([a-zA-Z0-9-]+)\])?\s+(.*)/s;

// Exit code in brackets: [exit 128]
const EXIT_CODE_RE = /\[exit (\d+)\]/;

// Jira ID from jobId context
const JIRA_ID_RE = /jiraId=([A-Z]+-\d+)/;

// ─── Level detection ──────────────────────────────────────────────────────────

function detectLevel(component: string | null, message: string, rawLine: string): LogLevel {
  const lower = rawLine.toLowerCase();
  if (lower.includes("error") || lower.includes("failed") || lower.includes("fatal")) return "error";
  if (lower.includes("warn")) return "warn";
  if (message.includes("PASS") || message.includes("PR created") || message.includes("Push successful")) return "success";
  return "info";
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export function parseLogLine(rawLine: string, source: LogSource): ParsedLogEntry {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const trimmed = rawLine.trim();

  const base: ParsedLogEntry = {
    id,
    timestamp,
    source,
    rawLine,
    component: null,
    jobId: null,
    level: "info",
    message: trimmed,
  };

  // Skip empty lines
  if (!trimmed) return base;

  // ── Structured agent block lines: [deepagent:thinking|plan|response] msg ─
  const agentMatch = AGENT_BLOCK_RE.exec(trimmed);
  if (agentMatch) {
    const agentBlock = agentMatch[2] as AgentBlock;
    const jobId = agentMatch[3] ?? null;
    const message = agentMatch[4] ?? "";
    return { ...base, component: "deepagent", jobId, agentBlock, message, level: "info" };
  }

  // ── Standard [component] [jobId?] message pattern ────────────────────────
  const compMatch = COMPONENT_RE.exec(trimmed);
  if (!compMatch) return base;

  const component = compMatch[1] as ComponentTag;
  const jobId = compMatch[2] ?? null;
  let rest = compMatch[3] ?? "";

  // ── deepagent:bash sub-parsing ────────────────────────────────────────────
  if (component === "deepagent:bash") {
    const bashMatch = BASH_ACTION_RE.exec(rest);
    if (bashMatch) {
      const bashAction = bashMatch[1] as BashActionType;
      const bashDirection = bashMatch[2] as "→" | "←";
      const message = bashMatch[3] ?? "";
      const exitMatch = EXIT_CODE_RE.exec(message);
      const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
      const level: LogLevel = exitCode && exitCode !== 0 ? "error" : bashDirection === "←" ? "success" : "info";
      return { ...base, component, jobId, bashAction, bashDirection, message, exitCode, level };
    }
  }

  // ── Standard level detection ──────────────────────────────────────────────
  const level = detectLevel(component, rest, trimmed);

  // Pull jiraId from message if present
  const jiraMatch = JIRA_ID_RE.exec(rest);
  if (jiraMatch && !jobId) {
    // no jobId override, but we have jiraId context in message
  }

  return { ...base, component, jobId, level, message: rest };
}

// ─── Job grouping helper ──────────────────────────────────────────────────────

export function extractJiraId(message: string): string | undefined {
  const m = JIRA_ID_RE.exec(message);
  return m?.[1];
}

export function extractVerdict(message: string): "PASS" | "FAIL" | "PARTIAL" | undefined {
  const m = /verdict=(PASS|FAIL|PARTIAL)/.exec(message);
  return m?.[1] as "PASS" | "FAIL" | "PARTIAL" | undefined;
}

export function extractPrUrl(message: string): string | undefined {
  const m = /https?:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(message);
  return m?.[0];
}
