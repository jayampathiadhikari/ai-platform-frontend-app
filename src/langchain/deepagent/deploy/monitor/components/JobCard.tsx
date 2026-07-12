"use client";

import { useState } from "react";
import type { JobGroup } from "@/lib/types";
import { LogEntry } from "./LogEntry";
import { ComponentBadge } from "./ComponentBadge";
import {
  CheckCircle2, XCircle, Clock, GitPullRequest, ChevronDown, ChevronRight,
  Loader2, AlertTriangle,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

// ─── Verdict badge ────────────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict?: string }) {
  if (!verdict) return null;
  const map: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    PASS:    { label: "PASS",    color: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30", icon: <CheckCircle2 className="w-3.5 h-3.5" /> },
    FAIL:    { label: "FAIL",    color: "bg-red-500/20     text-red-300     border-red-500/30",     icon: <XCircle className="w-3.5 h-3.5" /> },
    PARTIAL: { label: "PARTIAL", color: "bg-yellow-500/20  text-yellow-300  border-yellow-500/30",  icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  };
  const cfg = map[verdict];
  if (!cfg) return null;
  return (
    <span className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold border ${cfg.color}`}>
      {cfg.icon} {cfg.label}
    </span>
  );
}

// ─── Status indicator ─────────────────────────────────────────────────────────

function StatusDot({ status }: { status: JobGroup["status"] }) {
  if (status === "running") return <Loader2 className="w-3.5 h-3.5 text-sky-400 animate-spin shrink-0" />;
  if (status === "done")    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />;
  return <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0" />;
}

// ─── Pipeline stage progress ──────────────────────────────────────────────────

const PIPELINE_STAGES = [
  "deep:resolveTicket",
  "deep:setupWorkspace",
  "deep:devAgent",
  "deep:reviewAgent",
  "deep:postProcess",
] as const;

function PipelineProgress({ entries }: { entries: JobGroup["entries"] }) {
  const seen = new Set(entries.map(e => e.component));
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {PIPELINE_STAGES.map((stage, i) => {
        const active = seen.has(stage);
        return (
          <div key={stage} className="flex items-center gap-1">
            {i > 0 && (
              <div className={`w-4 h-px ${active ? "bg-slate-500" : "bg-slate-700"}`} />
            )}
            <ComponentBadge tag={active ? stage : null} size="sm" />
          </div>
        );
      })}
    </div>
  );
}

// ─── Job Card ─────────────────────────────────────────────────────────────────

interface JobCardProps {
  job: JobGroup;
}

export function JobCard({ job }: JobCardProps) {
  const [expanded, setExpanded] = useState(true);

  const elapsed = job.finishedAt
    ? Math.round((new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()) / 1000)
    : Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000);

  const shortJobId = job.jobId.slice(0, 8);

  // Glow colour by status/verdict
  const glowMap: Record<string, string> = {
    running: "shadow-sky-500/10 border-sky-500/20",
    done:    job.verdict === "PASS"    ? "shadow-emerald-500/10 border-emerald-500/20"
           : job.verdict === "PARTIAL" ? "shadow-yellow-500/10  border-yellow-500/20"
           :                            "shadow-red-500/10      border-red-500/20",
    failed: "shadow-red-500/10 border-red-500/20",
  };
  const glow = glowMap[job.status] ?? "";

  return (
    <Card className={`bg-[#0f1117] border shadow-lg ${glow} transition-all duration-500`}>
      {/* ── Header ── */}
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-start gap-3">
          <StatusDot status={job.status} />

          <div className="flex-1 min-w-0">
            {/* Top row: jiraId + verdict + PR link */}
            <div className="flex items-center gap-2 flex-wrap">
              {job.jiraId && (
                <span className="text-sm font-bold text-slate-100 font-mono">{job.jiraId}</span>
              )}
              <span className="text-[11px] text-slate-600 font-mono">#{shortJobId}</span>
              <VerdictBadge verdict={job.verdict} />
              {job.prUrl && (
                <a
                  href={job.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-sky-400 hover:text-sky-300 transition-colors"
                >
                  <GitPullRequest className="w-3 h-3" />
                  View PR
                </a>
              )}
            </div>

            {/* Pipeline progress */}
            <div className="mt-2">
              <PipelineProgress entries={job.entries} />
            </div>
          </div>

          {/* Elapsed + toggle */}
          <div className="flex items-center gap-3 shrink-0">
            <span className="flex items-center gap-1 text-[11px] text-slate-500">
              <Clock className="w-3 h-3" />
              {elapsed}s
            </span>
            <button
              onClick={() => setExpanded(e => !e)}
              className="text-slate-500 hover:text-slate-300 transition-colors"
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded
                ? <ChevronDown className="w-4 h-4" />
                : <ChevronRight className="w-4 h-4" />
              }
            </button>
          </div>
        </div>
      </CardHeader>

      {/* ── Log entries ── */}
      {expanded && (
        <>
          <Separator className="bg-white/5" />
          <CardContent className="p-0 pb-2">
            <div className="flex flex-col">
              {job.entries.map(entry => (
                <LogEntry key={entry.id} entry={entry} showComponent />
              ))}
            </div>
          </CardContent>
        </>
      )}
    </Card>
  );
}
