import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";
import type { JobResult, ReviewVerdict } from "../../types.js";

// ---------------------------------------------------------------------------
// Deep Agent Graph state — threaded through every node in the pipeline.
//
// Identical in shape to the langchain/langchain GraphState so the orchestrator
// nodes and routing helpers are interchangeable.  The key difference is the
// devAgent node: instead of createReactAgent, it uses createDeepAgent from
// the official `deepagents` npm package, which adds:
//   - write_todos task-planning tool (built-in)
//   - Virtual filesystem tools (read_file, write_file, edit_file, glob, grep, ls)
//   - Automatic context summarization
//   - Subagent delegation via the built-in `task` tool
//   - Prompt caching for Anthropic models
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

export type AfterDevAgent    = "reviewAgent" | "devAgent" | "teardown";
export type AfterReviewAgent = "postProcess" | "teardown";
