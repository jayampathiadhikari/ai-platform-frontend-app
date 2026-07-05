/**
 * graph.ts — Assembles the Deep Agent LangGraph StateGraph.
 *
 * This pipeline is structurally identical to langchain/langchain/orchestrator/graph.ts
 * but uses DeepDevAgent (powered by the official `deepagents` SDK) instead of
 * LangChainDevAgent (powered by createReactAgent).
 *
 * The `deepagents` SDK gives the agent built-in:
 *   - write_todos task-planning tool
 *   - Virtual filesystem (read_file, write_file, edit_file, glob, grep, ls)
 *   - Automatic context summarization
 *   - Subagent delegation via the built-in `task` tool
 *   - Prompt caching for Anthropic models
 *
 * Graph topology:
 *
 *   START
 *     │
 *     ▼
 *   resolveTicket ──(error)──┐
 *     │                      │
 *     ▼                      │
 *   setupWorkspace ─(error)──┤
 *     │                      │
 *     ▼                      │
 *   devAgent ──(error)───────┤
 *     │                      │
 *     ├──(FAIL, retry left)──┘ ← loops back to devAgent
 *     │
 *     ▼
 *   reviewAgent ──(error)────┤
 *     │                      │
 *     ▼                      ▼
 *   postProcess ──(error)── teardown
 *     │                      │
 *     ▼                      ▼
 *    END                     END
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

import type { ContextProvider } from "../../../shared/context-provider/types.js";
import { MockJiraContextProvider } from "../../../shared/context-provider/index.js";
import { registerJob, finishJob } from "../../../shared/job-registry.js";

import type { JobResult, ReviewVerdict } from "../../types.js";
import type { JiraStory, Workspace }     from "../../../shared/workspace-manager/types.js";

import {
    makeResolveTicketNode,
    makeSetupWorkspaceNode,
    makeDevAgentNode,
    makeReviewAgentNode,
    makePostProcessNode,
    makeTeardownNode,
} from "./nodes.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "2");

// ---------------------------------------------------------------------------
// LangGraph state annotation
// ---------------------------------------------------------------------------

const DeepOrchestratorState = Annotation.Root({
    // ── Inputs ──────────────────────────────────────────────────────────────
    jobId:   Annotation<string>(),
    jiraId:  Annotation<string>(),
    signal:  Annotation<AbortSignal | undefined>(),

    // ── resolveTicket ────────────────────────────────────────────────────────
    story:   Annotation<JiraStory | undefined>(),

    // ── setupWorkspace ───────────────────────────────────────────────────────
    workspace: Annotation<Workspace | undefined>(),

    // ── devAgent ─────────────────────────────────────────────────────────────
    devResult: Annotation<JobResult | undefined>(),

    // ── reviewAgent ──────────────────────────────────────────────────────────
    reviewResult: Annotation<ReviewVerdict | undefined>(),

    // ── Retry bookkeeping ────────────────────────────────────────────────────
    retryCount: Annotation<number>({
        default:  () => 0,
        reducer:  (_prev, next) => next,
    }),

    // ── Error short-circuit ──────────────────────────────────────────────────
    error: Annotation<string | undefined>(),
});

type S = typeof DeepOrchestratorState.State;

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** After devAgent: retry on FAIL (while budget remains), else continue. */
function routeAfterDevAgent(state: S): "reviewAgent" | "devAgent" | "teardown" {
    if (state.error) return "teardown";

    const verdict = state.devResult?.verdict;
    if (verdict === "FAIL" && state.retryCount < MAX_RETRIES) {
        console.log(
            `[deep:route] devAgent FAIL — scheduling retry ` +
            `(${state.retryCount}/${MAX_RETRIES})`
        );
        return "devAgent";
    }
    return "reviewAgent";
}

/** After reviewAgent: if an error was raised route to teardown, else continue. */
function routeAfterReviewAgent(state: S): "postProcess" | "teardown" {
    return state.error ? "teardown" : "postProcess";
}

/** Generic error-gate — routes to teardown if state.error is set, otherwise continues. */
function routeOnError(next: string) {
    return (state: S): string => (state.error ? "teardown" : next);
}

// ---------------------------------------------------------------------------
// Graph builder
// ---------------------------------------------------------------------------

export function buildGraph(contextProvider: ContextProvider = new MockJiraContextProvider()) {
    const graph = new StateGraph(DeepOrchestratorState)
        // ── Register nodes ───────────────────────────────────────────────────
        .addNode("resolveTicket",  makeResolveTicketNode(contextProvider))
        .addNode("setupWorkspace", makeSetupWorkspaceNode())
        .addNode("devAgent",       makeDevAgentNode())       // ← uses createDeepAgent SDK
        .addNode("reviewAgent",    makeReviewAgentNode())
        .addNode("postProcess",    makePostProcessNode())
        .addNode("teardown",       makeTeardownNode())

        // ── Entry point ──────────────────────────────────────────────────────
        .addEdge(START, "resolveTicket")

        // ── resolveTicket → setupWorkspace ───────────────────────────────────
        .addConditionalEdges("resolveTicket", routeOnError("setupWorkspace"), {
            setupWorkspace: "setupWorkspace",
            teardown:       "teardown",
        })

        // ── setupWorkspace → devAgent ────────────────────────────────────────
        .addConditionalEdges("setupWorkspace", routeOnError("devAgent"), {
            devAgent: "devAgent",
            teardown: "teardown",
        })

        // ── devAgent → reviewAgent | retry devAgent | teardown ────────────────
        .addConditionalEdges("devAgent", routeAfterDevAgent, {
            reviewAgent: "reviewAgent",
            devAgent:    "devAgent",
            teardown:    "teardown",
        })

        // ── reviewAgent → postProcess | teardown ─────────────────────────────
        .addConditionalEdges("reviewAgent", routeAfterReviewAgent, {
            postProcess: "postProcess",
            teardown:    "teardown",
        })

        // ── postProcess → END | teardown ─────────────────────────────────────
        .addConditionalEdges("postProcess", routeOnError(END), {
            [END]:    END,
            teardown: "teardown",
        })

        // ── teardown → END ───────────────────────────────────────────────────
        .addEdge("teardown", END);

    return graph.compile();
}

// ---------------------------------------------------------------------------
// Public entry point — same signature as langchain/langchain runJob
// ---------------------------------------------------------------------------

/**
 * Resolves a Jira ticket, spins up an isolated workspace, runs the full
 * Deep Agent pipeline (deepagents SDK + LangGraph orchestration), opens a PR
 * on success, and tears down the workspace.
 *
 * @param jiraId          - The Jira ticket ID (e.g. "PROJ-42")
 * @param jobId           - A unique job identifier (used for logging and the job registry)
 * @param contextProvider - Jira context provider (defaults to MockJiraContextProvider)
 */
export async function runJob(
    jiraId: string,
    jobId:  string,
    contextProvider: ContextProvider = new MockJiraContextProvider()
): Promise<void> {
    console.log(`[deep:orchestrator] [${jobId}] Starting Deep Agent job for jiraId=${jiraId}`);

    const controller = registerJob(jobId, jiraId);
    const { signal } = controller;

    const graph = buildGraph(contextProvider);

    try {
        await graph.invoke(
            {
                jobId,
                jiraId,
                signal,
                retryCount: 0,
            },
            {
                configurable:   { thread_id: jobId },
                recursionLimit: 100,
            }
        );
    } catch (err) {
        const wasCancelled = signal.aborted;
        finishJob(jobId, wasCancelled ? "cancelled" : "failed");

        if (wasCancelled) {
            console.warn(`[deep:orchestrator] [${jobId}] Job was cancelled`);
        } else {
            console.error(`[deep:orchestrator] [${jobId}] Unhandled graph error:`, err);
        }
        return;
    }

    console.log(`[deep:orchestrator] [${jobId}] Graph execution complete`);
}
