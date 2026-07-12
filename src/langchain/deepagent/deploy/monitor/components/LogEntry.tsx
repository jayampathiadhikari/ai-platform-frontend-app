"use client";

import type { ParsedLogEntry } from "@/lib/types";
import { ComponentBadge } from "./ComponentBadge";
import {
  GitCommit, GitBranch, FilePlus, Package, FileEdit,
  ChevronRight, Brain, ClipboardList, MessageSquare,
  Terminal, AlertCircle, CheckCircle2,
  ArrowRight, ArrowLeft, Info,
} from "lucide-react";

// ─── Action icon map ──────────────────────────────────────────────────────────

function BashIcon({ action, direction }: { action?: string; direction?: "→" | "←" }) {
  if (direction === "←") return <ArrowLeft className="w-3.5 h-3.5 text-emerald-400" />;
  if (!action)            return <Terminal className="w-3.5 h-3.5 text-slate-400" />;

  const a = action.toUpperCase();
  if (a.includes("COMMIT") && a.includes("PUSH")) return <GitCommit className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("COMMIT")) return <GitCommit className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("PUSH"))   return <ArrowRight className="w-3.5 h-3.5 text-amber-400" />;
  if (a.includes("STAGE"))  return <FilePlus className="w-3.5 h-3.5 text-sky-400" />;
  if (a.includes("STATUS")) return <GitBranch className="w-3.5 h-3.5 text-sky-400" />;
  if (a.includes("INSTALL"))return <Package className="w-3.5 h-3.5 text-violet-400" />;
  if (a.includes("WRITE"))  return <FileEdit className="w-3.5 h-3.5 text-green-400" />;
  if (a.includes("READ"))   return <ChevronRight className="w-3.5 h-3.5 text-slate-400" />;
  return <Terminal className="w-3.5 h-3.5 text-slate-400" />;
}

function AgentBlockIcon({ block }: { block?: string }) {
  if (block === "thinking") return <Brain className="w-4 h-4 text-purple-400" />;
  if (block === "plan")     return <ClipboardList className="w-4 h-4 text-blue-400" />;
  if (block === "response") return <MessageSquare className="w-4 h-4 text-green-400" />;
  return null;
}

function LevelIcon({ level }: { level: string }) {
  if (level === "error")   return <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
  if (level === "warn")    return <AlertCircle className="w-3.5 h-3.5 text-yellow-400 shrink-0" />;
  if (level === "success") return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  return <Info className="w-3.5 h-3.5 text-slate-500 shrink-0" />;
}

// ─── Message text formatting ──────────────────────────────────────────────────

function truncate(s: string, max = 320) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function MessageText({ entry }: { entry: ParsedLogEntry }) {
  const { agentBlock, bashAction, bashDirection, message, level, exitCode } = entry;

  // Agent block header — prominent display
  if (agentBlock) {
    const labels: Record<string, string> = {
      thinking: "Agent is thinking…",
      plan:     "Agent plan",
      response: "Agent response",
    };
    return (
      <span className="italic text-slate-300 font-medium">{labels[agentBlock] ?? message}</span>
    );
  }

  // Bash output (←) — monospace, dimmed
  if (bashDirection === "←") {
    return (
      <span className="font-mono text-[11px] text-emerald-300/80 leading-tight break-all">
        {truncate(message)}
      </span>
    );
  }

  // Bash command (→)
  if (bashDirection === "→") {
    return (
      <span className="font-mono text-[11px] text-sky-300 leading-tight break-all">
        {truncate(message)}
      </span>
    );
  }

  // Error / exit code
  const colorMap: Record<string, string> = {
    error:   "text-red-300",
    warn:    "text-yellow-300",
    success: "text-emerald-300",
    info:    "text-slate-300",
  };
  const color = colorMap[level] ?? "text-slate-300";

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

  // Agent block header — special styling
  if (agentBlock) {
    const blockColors: Record<string, string> = {
      thinking: "border-purple-500/40 bg-purple-950/30",
      plan:     "border-blue-500/40   bg-blue-950/30",
      response: "border-green-500/40  bg-green-950/30",
    };
    const cls = blockColors[agentBlock] ?? "border-slate-600 bg-slate-900/30";
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${cls} my-1`}>
        <AgentBlockIcon block={agentBlock} />
        <MessageText entry={entry} />
        <span className="ml-auto text-[10px] text-slate-600 font-mono shrink-0">
          {new Date(timestamp).toLocaleTimeString()}
        </span>
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
    <div className={`flex items-start gap-2 px-3 py-1.5 border-l-2 ${border} hover:bg-white/[0.02] transition-colors group`}>
      {/* Timestamp */}
      <span className="text-[10px] text-slate-600 font-mono shrink-0 mt-0.5 w-[68px]">
        {new Date(timestamp).toLocaleTimeString()}
      </span>

      {/* Component badge */}
      {showComponent && component && (
        <ComponentBadge tag={component} />
      )}

      {/* Bash action tag */}
      {bashAction && (
        <span className="flex items-center gap-1 shrink-0">
          <BashIcon action={bashAction} direction={bashDirection} />
          <span className="text-[10px] font-mono text-slate-500 hidden group-hover:inline">
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
