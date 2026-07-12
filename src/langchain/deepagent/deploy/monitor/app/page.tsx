"use client";

import { useLogStream } from "@/hooks/useLogStream";
import { JobCard } from "@/components/JobCard";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Wifi, WifiOff, Activity, Bot, Loader2
} from "lucide-react";

// ─── Connection status bar ────────────────────────────────────────────────────

function StatusBar({ connected, error, jobCount }: {
  connected: boolean;
  error: string | null;
  jobCount: number;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-[#0a0c10] border-b border-white/5 text-xs">
      <div className={`flex items-center gap-1.5 font-medium ${connected ? "text-emerald-400" : "text-red-400"}`}>
        {connected
          ? <><Wifi className="w-3.5 h-3.5" /> Live</>
          : <><WifiOff className="w-3.5 h-3.5" /> {error ?? "Disconnected"}</>
        }
      </div>
      <span className="text-slate-600">·</span>
      <span className="text-slate-400">{jobCount} job{jobCount !== 1 ? "s" : ""}</span>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ connected }: { connected: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-[60vh] gap-4 text-slate-600">
      {connected
        ? <>
            <Activity className="w-10 h-10 animate-pulse text-slate-700" />
            <p className="text-sm">Waiting for agent jobs…</p>
            <p className="text-xs">Trigger one with: <code className="bg-slate-800 text-slate-300 px-2 py-0.5 rounded">POST /run/deepagent</code></p>
          </>
        : <>
            <Loader2 className="w-10 h-10 animate-spin text-slate-700" />
            <p className="text-sm">Connecting to agent…</p>
          </>
      }
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const { jobs, connected, error } = useLogStream();

  return (
    <div className="flex flex-col h-screen bg-[#080a0f] text-slate-200">

      {/* ── Header ── */}
      <header className="flex items-center gap-3 px-5 py-3 bg-[#0a0c10] border-b border-white/5">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Bot className="w-6 h-6 text-violet-400" />
            {connected && (
              <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
            )}
          </div>
          <span className="text-sm font-bold text-slate-100 tracking-tight">DeepAgent Monitor</span>
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          {jobs.filter(j => j.status === "running").map(j => (
            <span key={j.jobId} className="flex items-center gap-1 text-[11px] bg-sky-500/10 text-sky-400 border border-sky-500/20 px-2 py-0.5 rounded-full">
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              {j.jiraId ?? j.jobId.slice(0, 6)}
            </span>
          ))}
        </div>
      </header>

      {/* ── Status bar ── */}
      <StatusBar connected={connected} error={error} jobCount={jobs.length} />

      {/* ── Job list ── */}
      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col gap-4">
          {jobs.length === 0
            ? <EmptyState connected={connected} />
            : jobs.map(job => <JobCard key={job.jobId} job={job} />)
          }
        </div>
      </ScrollArea>
    </div>
  );
}
