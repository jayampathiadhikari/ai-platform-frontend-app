/**
 * graph.ts — Assembles the LangGraph StateGraph for the orchestration pipeline.
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
 *   planStory                │
 *     │                      │
 *     ▼                      │
 *   devAgent ──(error)───────┤
 *     │                      │
 *     ├──(FAIL, retry left)──┘ ← loops back to devAgent
 *     │
 *     ▼
 *   reviewAgent ──(error)────┤
 *     │                      │
 *     ▼                      │
 *   postProcess              │
 *     │                      ▼
 *     ▼                   teardown
 *    END                     │
 *                            ▼
 *                           END
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

import type { ContextProvider } from "../../../shared/context-provider/types.js";
import { MockJiraContextProvider } from "../../../shared/context-provider/index.js";
import { registerJob, finishJob } from "../../../shared/job-registry.js";

import type { JobResult, ReviewVerdict } from "../../types.js";
import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";

import {
    makeResolveTicketNode,
    makeSetupWorkspaceNode,
    makePlanStoryNode,
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
//
// We define fields individually via Annotation so LangGraph can satisfy its
// internal StateDefinition constraint. The derived State type is used everywhere
// instead of the raw GraphState interface.
// ---------------------------------------------------------------------------

const OrchestratorState = Annotation.Root({
    // ── Inputs ──────────────────────────────────────────────────────────────
    jobId:   Annotation<string>(),
    jiraId:  Annotation<string>(),
    signal:  Annotation<AbortSignal | undefined>(),

    // ── Built during resolveTicket ───────────────────────────────────────────
    story:   Annotation<JiraStory | undefined>(),

    // ── Built during setupWorkspace ──────────────────────────────────────────
    workspace: Annotation<Workspace | undefined>(),

    // ── Written by devAgent ──────────────────────────────────────────────────
    devResult: Annotation<JobResult | undefined>(),

    // ── Written by reviewAgent ───────────────────────────────────────────────
    reviewResult: Annotation<ReviewVerdict | undefined>(),

    // ── Retry bookkeeping ────────────────────────────────────────────────────
    retryCount: Annotation<number>({
        default:  () => 0,
        reducer:  (_prev, next) => next,
    }),

    // ── Error short-circuit ──────────────────────────────────────────────────
    error: Annotation<string | undefined>(),
});

/** The concrete state type derived from the annotation — use this everywhere. */
type S = typeof OrchestratorState.State;

// ---------------------------------------------------------------------------
// Routing helpers
// ---------------------------------------------------------------------------

/** After devAgent: retry on FAIL (while budget remains), else continue. */
function routeAfterDevAgent(state: S): "reviewAgent" | "devAgent" | "teardown" {
    if (state.error) return "teardown";

    const verdict = state.devResult?.verdict;
    if (verdict === "FAIL" && state.retryCount < MAX_RETRIES) {
        console.log(
            `[orchestrator:route] devAgent FAIL — scheduling retry ` +
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
    const graph = new StateGraph(OrchestratorState)
        // ── Register nodes ────────────────────────────────────────────────────
        .addNode("resolveTicket",  makeResolveTicketNode(contextProvider))
        .addNode("setupWorkspace", makeSetupWorkspaceNode())
        .addNode("planStory",      makePlanStoryNode())
        .addNode("devAgent",       makeDevAgentNode())
        .addNode("reviewAgent",    makeReviewAgentNode())
        .addNode("postProcess",    makePostProcessNode())
        .addNode("teardown",       makeTeardownNode())

        // ── Entry point ───────────────────────────────────────────────────────
        .addEdge(START, "resolveTicket")

        // ── resolveTicket → setupWorkspace  (or teardown on error) ────────────
        .addConditionalEdges("resolveTicket", routeOnError("setupWorkspace"), {
            setupWorkspace: "setupWorkspace",
            teardown:       "teardown",
        })

        // ── setupWorkspace → planStory  (or teardown on error) ────────────────
        .addConditionalEdges("setupWorkspace", routeOnError("planStory"), {
            planStory: "planStory",
            teardown:  "teardown",
        })

        // ── planStory → devAgent  (always, planStory is a pass-through stub) ──
        .addEdge("planStory", "devAgent")

        // ── devAgent → reviewAgent | retry devAgent | teardown ────────────────
        .addConditionalEdges("devAgent", routeAfterDevAgent, {
            reviewAgent: "reviewAgent",
            devAgent:    "devAgent",
            teardown:    "teardown",
        })

        // ── reviewAgent → postProcess  (or teardown on error) ─────────────────
        .addConditionalEdges("reviewAgent", routeAfterReviewAgent, {
            postProcess: "postProcess",
            teardown:    "teardown",
        })

        // ── postProcess → END  (or teardown on error) ─────────────────────────
        .addConditionalEdges("postProcess", routeOnError(END), {
            [END]:    END,
            teardown: "teardown",
        })

        // ── teardown → END ────────────────────────────────────────────────────
        .addEdge("teardown", END);

    return graph.compile();
}

// ---------------------------------------------------------------------------
// Public entry point — mirrors the claude-sdk orchestrator's runJob signature
// ---------------------------------------------------------------------------

/**
 * Resolves a Jira ticket, spins up an isolated workspace, runs the full
 * multi-agent pipeline, opens a PR on success, and tears down the workspace.
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
    console.log(`[orchestrator] [${jobId}] Starting LangGraph job for jiraId=${jiraId}`);

    // Register with the job registry so the job can be cancelled via the API
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
            console.warn(`[orchestrator] [${jobId}] Job was cancelled`);
        } else {
            console.error(`[orchestrator] [${jobId}] Unhandled graph error:`, err);
        }
        return;
    }

    console.log(`[orchestrator] [${jobId}] Graph execution complete`);
}
