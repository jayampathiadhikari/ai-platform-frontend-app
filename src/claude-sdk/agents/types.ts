import type { JiraStory, Workspace } from "../../shared/workspace-manager/types.js";

export interface JobResult {
  storyId: string;
  verdict: "PASS" | "FAIL" | "PARTIAL";
  prUrl?: string;
  reason?: string;
  costUsd: number;
  turns: number;
}

export interface ReviewVerdict {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  reason: string;
  prUrl?: string;
}

export interface Agent {
  run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult>;
}