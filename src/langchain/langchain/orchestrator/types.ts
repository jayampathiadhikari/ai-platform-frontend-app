import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";
import type { JobResult, ReviewVerdict } from "../../types.js";

// ---------------------------------------------------------------------------
// LangGraph state — threaded through every node in the pipeline.
// ---------------------------------------------------------------------------

export interface GraphState {
    // ── Inputs (set once at graph invocation) ────────────────────────────────
    jobId:   string;
    jiraId:  string;
    /** AbortSignal passed down from the job registry — lets any node bail early. */
    signal?: AbortSignal;

    // ── Built by resolveTicket ────────────────────────────────────────────────
    story?: JiraStory;

    // ── Built by setupWorkspace ───────────────────────────────────────────────
    workspace?: Workspace;

    // ── Written by devAgent ───────────────────────────────────────────────────
    devResult?: JobResult;

    // ── Written by reviewAgent ────────────────────────────────────────────────
    /** Final verdict after (optional) LLM review. Falls through from devResult if stub. */
    reviewResult?: ReviewVerdict;

    // ── Retry bookkeeping ─────────────────────────────────────────────────────
    retryCount: number;

    // ── Error short-circuit ───────────────────────────────────────────────────
    /** When set by any node, the graph routes immediately to teardown → __end__. */
    error?: string;
}

// ---------------------------------------------------------------------------
// Routing return values (used in conditional edges)
// ---------------------------------------------------------------------------

export type AfterDevAgent    = "reviewAgent"  | "devAgent"   | "teardown";
export type AfterReviewAgent = "postProcess"  | "teardown";
