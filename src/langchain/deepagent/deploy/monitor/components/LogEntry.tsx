"use client";

import type { ParsedLogEntry } from "@/lib/types";
import { ComponentBadge } from "./ComponentBadge";
import {
  GitCommit, GitBranch, FilePlus, Package, FileEdit,
  ChevronRight,
  Terminal, AlertCircle, CheckCircle2,
  ArrowRight, ArrowLeft, Info,
} from "lucide-react";

// ─── Action icon map ──────────────────────────────────────────────────────────

function BashIcon({ action, direction }: { action?: string; direction?: "→" | "←" }) {
  if (direction === "←") return <ArrowLeft className="w-3.5 h-3.5 text-emerald-400" />;
  if (!action)            return <Terminal className="w-3.5 h-3.5 text-muted-foreground" />;

  const a = action.toUpperCase();
  if (a.includes("COMMIT") && a.includes("PUSH")) return <GitCommit className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("COMMIT")) return <GitCommit className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("PUSH"))   return <ArrowRight className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("STAGE"))  return <FilePlus className="w-3.5 h-3.5 text-sky-400" />;
  if (a.includes("STATUS")) return <GitBranch className="w-3.5 h-3.5 text-sky-400" />;
  if (a.includes("INSTALL"))return <Package className="w-3.5 h-3.5 text-violet-400" />;
  if (a.includes("WRITE"))  return <FileEdit className="w-3.5 h-3.5 text-green-400" />;
  if (a.includes("READ"))   return <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />;
  return <Terminal className="w-3.5 h-3.5 text-muted-foreground" />;
}


function LevelIcon({ level }: { level: string }) {
  if (level === "error")   return <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  if (level === "warn")    return <AlertCircle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />;
  if (level === "success") return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  return <Info className="w-3.5 h-3.5 text-muted-foreground shrink-0" />;
}

// ─── Message text formatting ──────────────────────────────────────────────────

function truncate(s: string, max = 320) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function MessageText({ entry }: { entry: ParsedLogEntry }) {
  const { agentBlock, bashAction, bashDirection, message, level, exitCode } = entry;

  // Agent block header — shown as a slim phase-change divider
  if (agentBlock) {
    const labels: Record<string, string> = {
      thinking: "Thinking (Agent is reasoning internally before acting)",
      plan:     "Acting on plan (Agent is executing tools & shell commands)",
      response: "Responding (Agent is summarising results & wrapping up)",
    };
    return (
      <span className="text-[11px] text-muted-foreground/70 font-medium">{labels[agentBlock] ?? message}</span>
    );
  }

  // Bash output (←) — monospace, dimmed
  if (bashDirection === "←") {
    return (
      <span className="font-mono text-[11px] text-emerald-600 dark:text-emerald-300/80 leading-tight break-all">
        {truncate(message)}
      </span>
    );
  }

  // Bash command (→)
  if (bashDirection === "→") {
    return (
      <span className="font-mono text-[11px] text-sky-600 dark:text-sky-300 leading-tight break-all">
        {truncate(message)}
      </span>
    );
  }

  // Error / exit code
  const colorMap: Record<string, string> = {
    error:   "text-red-600 dark:text-red-300",
    warn:    "text-yellow-600 dark:text-yellow-300",
    success: "text-emerald-600 dark:text-emerald-300",
    info:    "text-foreground/80",
  };
  const color = colorMap[level] ?? "text-foreground/80";

  return (
    <span className={`text-[12px] ${color} leading-snug break-words`}>
      {exitCode !== undefined && exitCode !== 0 && (
        <span className="mr-1.5 text-red-400 font-bold">[exit {exitCode}]</span>
      )}
      {truncate(message)}
    </span>
  );
}

// ─── Log Entry row ────────────────────────────────────────────────────────────

interface LogEntryProps {
  entry: ParsedLogEntry;
  showComponent?: boolean;
}

export function LogEntry({ entry, showComponent = true }: LogEntryProps) {
  const { component, bashAction, bashDirection, agentBlock, level, timestamp } = entry;

  // Agent block — slim phase-change divider, not a section container
  if (agentBlock) {
    const blockStyles: Record<string, { dot: string; line: string }> = {
      thinking: { dot: "bg-purple-400/70",  line: "border-purple-400/20" },
      plan:     { dot: "bg-blue-400/70",    line: "border-blue-400/20"   },
      response: { dot: "bg-emerald-400/70", line: "border-emerald-400/20" },
    };
    const style = blockStyles[agentBlock] ?? { dot: "bg-muted-foreground/40", line: "border-muted-foreground/20" };
    return (
      <div className="flex items-center gap-2 px-3 py-1 my-0.5">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`} />
        <div className={`flex-1 border-t border-dashed ${style.line}`} />
        <MessageText entry={entry} />
        <span className="text-[10px] text-muted-foreground/50 font-mono shrink-0">
          {new Date(timestamp).toLocaleTimeString()}
        </span>
        <div className={`flex-1 border-t border-dashed ${style.line}`} />
      </div>
    );
  }

  // Border accent by level
  const levelBorder: Record<string, string> = {
    error:   "border-l-red-500",
    warn:    "border-l-yellow-500",
    success: "border-l-emerald-500",
    info:    "border-l-transparent",
  };
  const border = levelBorder[level] ?? "border-l-transparent";

  return (
    <div className={`flex items-start gap-2 px-3 py-1.5 border-l-2 ${border} hover:bg-foreground/[0.03] transition-colors group`}>
      {/* Timestamp */}
      <span className="text-[10px] text-muted-foreground/70 font-mono shrink-0 mt-0.5 w-[68px]">
        {new Date(timestamp).toLocaleTimeString()}
      </span>

      {/* Component badge */}
      {showComponent && component && (
        <ComponentBadge tag={component} size="md" />
      )}

      {/* Bash action tag */}
      {bashAction && (
        <span className="flex items-center gap-1 shrink-0">
          <BashIcon action={bashAction} direction={bashDirection} />
          <span className="text-[10px] font-mono text-muted-foreground hidden group-hover:inline">
            {bashAction}
          </span>
        </span>
      )}

      {/* No bash action: show level icon */}
      {!bashAction && !agentBlock && (
        <LevelIcon level={level} />
      )}

      {/* Message */}
      <div className="flex-1 min-w-0">
        <MessageText entry={entry} />
      </div>
    </div>
  );
}
