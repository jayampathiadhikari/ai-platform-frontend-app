"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ParsedLogEntry, JobGroup } from "@/lib/types";
import { parseLogLine } from "@/lib/log-parser";
import { extractJiraId, extractVerdict, extractPrUrl } from "@/lib/log-parser";

const ORPHAN_JOB_ID = "__global__";

function upsertJob(
  map: Map<string, JobGroup>,
  jobId: string,
  patch: Partial<JobGroup>
): Map<string, JobGroup> {
  const next = new Map(map);
  const existing = next.get(jobId) ?? {
    jobId,
    startedAt: new Date().toISOString(),
    status: "running" as const,
    entries: [],
  };
  next.set(jobId, { ...existing, ...patch });
  return next;
}

export function useLogStream() {
  const [jobs, setJobs] = useState<Map<string, JobGroup>>(new Map());
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource("/api/logs/stream");
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    es.onerror = () => {
      setConnected(false);
      setError("Connection lost — retrying…");
    };

    es.onmessage = (event: MessageEvent<string>) => {
      let raw: { line?: string; source?: string; error?: string; ts?: string } | null = null;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!raw) return;

      if (raw.error) {
        setError(raw.error);
        return;
      }

      const line = raw.line ?? "";
      const source = (raw.source as "deepagent-agent" | "deepagent-executor") ?? "deepagent-agent";

      const entry = parseLogLine(line, source);

      setJobs(prev => {
        const jobId = entry.jobId ?? ORPHAN_JOB_ID;

        // Accumulate entry
        let next = upsertJob(prev, jobId, {
          entries: [...(prev.get(jobId)?.entries ?? []), entry],
        });

        // Update metadata from known log patterns
        const msg = entry.message;

        if (entry.component === "deep:orchestrator" && msg.includes("Starting Deep Agent job")) {
          const jiraId = extractJiraId(entry.rawLine) ?? extractJiraId(msg);
          if (jiraId) next = upsertJob(next, jobId, { jiraId });
        }

        if (entry.component === "POST /run/deepagent" || (entry.component === null && entry.rawLine.includes("jiraId="))) {
          const jiraId = extractJiraId(entry.rawLine);
          if (jiraId && jobId !== ORPHAN_JOB_ID) next = upsertJob(next, jobId, { jiraId });
        }

        const verdict = extractVerdict(msg) ?? extractVerdict(entry.rawLine);
        if (verdict) next = upsertJob(next, jobId, { verdict });

        const prUrl = extractPrUrl(msg) ?? extractPrUrl(entry.rawLine);
        if (prUrl) next = upsertJob(next, jobId, { prUrl });

        if (msg.includes("Job complete") || msg.includes("Graph execution complete")) {
          next = upsertJob(next, jobId, { status: "done", finishedAt: entry.timestamp });
        }
        if (msg.includes("Error path") || entry.component === "deep:teardown") {
          next = upsertJob(next, jobId, { status: "failed", finishedAt: entry.timestamp });
        }

        return next;
      });
    };

    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  // Sort jobs:
  //  1. Real running jobs (newest first)
  //  2. Real finished jobs (newest first)
  //  3. __global__ (system console) always pinned to bottom
  const jobList = Array.from(jobs.values())
    .filter(j => j.jobId !== ORPHAN_JOB_ID || j.entries.length > 0)
    .sort((a, b) => {
      const aIsGlobal = a.jobId === ORPHAN_JOB_ID;
      const bIsGlobal = b.jobId === ORPHAN_JOB_ID;

      // __global__ always sinks to the bottom
      if (aIsGlobal && !bIsGlobal) return 1;
      if (bIsGlobal && !aIsGlobal) return -1;

      // Among real jobs: running first, then finished by recency
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });

  return { jobs: jobList, connected, error };
}
