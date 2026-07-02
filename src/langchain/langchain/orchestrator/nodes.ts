/**
 * nodes.ts — Every node in the LangGraph orchestrator pipeline.
 *
 * Each export is a *factory function* that closes over its dependencies (LLM
 * config, context provider, etc.) and returns a plain async function that
 * receives the current GraphState and returns a partial state update.
 *
 * Node order in the graph:
 *   resolveTicket → setupWorkspace → planStory → devAgent
 *       → reviewAgent → postProcess → __end__
 *
 * Error path (any node can set state.error):
 *   → teardown → __end__
 */

import { fileURLToPath } from "url";
import path              from "path";
import fs                from "fs/promises";

import type { GraphState }    from "./types.js";
import type { JiraStory }     from "../../../shared/workspace-manager/types.js";
import type { ContextProvider } from "../../../shared/context-provider/types.js";
import type { ReviewVerdict }  from "../../types.js";

import {
    setupWorkspace,
    pushAndTeardown,
    teardownWorkspace,
} from "../../../shared/workspace-manager/workspace-manager.js";
import { createPullRequest }       from "../../../shared/git/github.js";
import { finishJob }               from "../../../shared/job-registry.js";
import { parseAgentDirective }     from "../../../claude-sdk/orchestrator/helpers.js";
import { LangChainDevAgent }       from "../agents/dev-agent.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_MD_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../claude-sdk/agents/CLAUDE.md"
);

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "2");

// ---------------------------------------------------------------------------
// Node type alias
// ---------------------------------------------------------------------------

type NodeFn = (state: GraphState) => Promise<Partial<GraphState>>;

// ---------------------------------------------------------------------------
// 1. resolveTicket
//    Fetches the Jira ticket, parses the @agent directive, loads CLAUDE.md,
//    and assembles the JiraStory that all downstream nodes depend on.
// ---------------------------------------------------------------------------

export function makeResolveTicketNode(contextProvider: ContextProvider): NodeFn {
    return async (state) => {
        const { jobId, jiraId } = state;
        console.log(`[orchestrator:resolveTicket] [${jobId}] Fetching ticket=${jiraId}`);

        // 1a. Fetch the Jira ticket
        const ticket = await contextProvider.getTicket(jiraId);
        if (!ticket) {
            const error = `Ticket "${jiraId}" not found`;
            console.error(`[orchestrator:resolveTicket] [${jobId}] ${error}`);
            return { error };
        }
        console.log(
            `[orchestrator:resolveTicket] [${jobId}] Resolved: ${ticket.id} — ` +
            `"${ticket.title}" (${ticket.status}, ${ticket.priority})`
        );

        // 1b. Parse the @agent directive from ticket comments
        const directive = parseAgentDirective(ticket);
        if (!directive) {
            const error = `No @agent directive found in comments for ticket "${jiraId}"`;
            console.error(`[orchestrator:resolveTicket] [${jobId}] ${error}`);
            return { error };
        }
        console.log(
            `[orchestrator:resolveTicket] [${jobId}] Directive parsed — ` +
            `repo=${directive.repoUrl} base=${directive.baseBranch}`
        );

        // 1c. Load operational guidelines (CLAUDE.md)
        const claudeMd = await fs.readFile(CLAUDE_MD_PATH, "utf8");
        console.log(`[orchestrator:resolveTicket] [${jobId}] CLAUDE.md loaded (${claudeMd.length} bytes)`);

        const story: JiraStory = {
            id:          ticket.id,
            projectId:   "project-1",
            tenantId:    "tenant",
            repoUrl:     directive.repoUrl,
            baseBranch:  directive.baseBranch,
            taskMd:      ticket.description,
            claudeMd,
            description: ticket.description,
            retryCount:  state.retryCount,
            checkpointRef: "",
        };

        return { story };
    };
}

// ---------------------------------------------------------------------------
// 2. setupWorkspace
//    Clones the repo, creates the agent branch, and writes TASK.md / CLAUDE.md.
//    The resulting Workspace object is passed to all downstream nodes.
// ---------------------------------------------------------------------------

export function makeSetupWorkspaceNode(): NodeFn {
    return async (state) => {
        const { jobId, story } = state;
        if (!story) return { error: "setupWorkspace: story is missing from state" };

        console.log(`[orchestrator:setupWorkspace] [${jobId}] Cloning repo and preparing workspace...`);
        try {
            const workspace = await setupWorkspace(story);
            console.log(
                `[orchestrator:setupWorkspace] [${jobId}] Ready — ` +
                `dir=${workspace.jobDir} branch=${workspace.branch}`
            );
            return { workspace };
        } catch (err) {
            const error = `setupWorkspace failed: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[orchestrator:setupWorkspace] [${jobId}]`, error);
            return { error };
        }
    };
}

// ---------------------------------------------------------------------------
// 3. planStory  (STUB — pass-through)
//    Placeholder for a future PlannerAgent that decomposes or annotates the
//    story before handing it to the DevAgent.
//    Replace the body with a real LLM call when ready.
// ---------------------------------------------------------------------------

export function makePlanStoryNode(): NodeFn {
    return async (state) => {
        console.log(
            `[orchestrator:planStory] [${state.jobId}] ` +
            `(stub) Passing story through unchanged`
        );
        // TODO: invoke PlannerAgent here, update state.story with a plan
        return {};
    };
}

// ---------------------------------------------------------------------------
// 4. devAgent
//    Runs the LangChain-backed developer agent inside the prepared workspace.
//    On retry the same workspace/branch is reused so the agent can build on
//    its previous commits.
// ---------------------------------------------------------------------------

export function makeDevAgentNode(): NodeFn {
    return async (state) => {
        const { jobId, story, workspace, signal, retryCount } = state;
        if (!story)     return { error: "devAgent: story is missing from state" };
        if (!workspace) return { error: "devAgent: workspace is missing from state" };

        if (retryCount > 0) {
            console.log(`[orchestrator:devAgent] [${jobId}] Retry #${retryCount}/${MAX_RETRIES}`);
        }

        console.log(`[orchestrator:devAgent] [${jobId}] Handing off to LangChainDevAgent...`);
        try {
            const agent     = new LangChainDevAgent();
            const devResult = await agent.run(story, workspace, signal);
            console.log(
                `[orchestrator:devAgent] [${jobId}] Finished — ` +
                `verdict=${devResult.verdict} turns=${devResult.turns} ` +
                `cost=$${devResult.costUsd.toFixed(4)}`
            );
            // Increment retryCount now so the router's guard (retryCount < MAX_RETRIES)
            // is evaluated against the *updated* value on the next pass.
            return {
                devResult,
                retryCount: devResult.verdict === "FAIL" ? retryCount + 1 : retryCount,
            };
        } catch (err) {
            const error = `devAgent threw: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[orchestrator:devAgent] [${jobId}]`, error);
            return { error };
        }
    };
}

// ---------------------------------------------------------------------------
// 5. reviewAgent  (STUB — pass-through)
//    Placeholder for a future LLM-based code reviewer. Currently reads
//    REVIEW.json written by the dev-agent and promotes it to reviewResult.
//    Replace the body with a real reviewer LLM call when ready.
// ---------------------------------------------------------------------------

export function makeReviewAgentNode(): NodeFn {
    return async (state) => {
        const { jobId, workspace, devResult } = state;
        if (!devResult)  return { error: "reviewAgent: devResult is missing from state" };
        if (!workspace)  return { error: "reviewAgent: workspace is missing from state" };

        console.log(
            `[orchestrator:reviewAgent] [${jobId}] ` +
            `(stub) Promoting devAgent verdict as reviewResult`
        );

        // TODO: invoke ReviewAgent LLM here to independently inspect the diff.
        // For now, trust whatever the dev-agent wrote in REVIEW.json.
        const reviewResult: ReviewVerdict = {
            verdict: devResult.verdict,
            reason:  devResult.reason ?? "(no reason provided)",
        };

        return { reviewResult };
    };
}

// ---------------------------------------------------------------------------
// 6. postProcess
//    Opens a GitHub PR for PASS / PARTIAL verdicts, marks the job done in
//    the registry, then pushes the branch and tears down the workspace clone.
// ---------------------------------------------------------------------------

export function makePostProcessNode(): NodeFn {
    return async (state) => {
        const { jobId, story, workspace, devResult, reviewResult } = state;
        if (!story)        return { error: "postProcess: story is missing from state" };
        if (!workspace)    return { error: "postProcess: workspace is missing from state" };
        if (!devResult)    return { error: "postProcess: devResult is missing from state" };
        if (!reviewResult) return { error: "postProcess: reviewResult is missing from state" };

        const verdict = reviewResult.verdict;
        console.log(`[orchestrator:postProcess] [${jobId}] verdict=${verdict}`);

        if (verdict === "PASS" || verdict === "PARTIAL") {
            console.log(
                `[orchestrator:postProcess] [${jobId}] Opening PR — ` +
                `head=${workspace.branch} base=${story.baseBranch}`
            );
            try {
                const pr = await createPullRequest({
                    remoteUrl: workspace.remoteUrl,
                    head:      workspace.branch,
                    base:      story.baseBranch,
                    title:     `[${story.id}] ${story.description}`,
                    body:
                        `Automated implementation of Jira story ${story.id}.` +
                        (reviewResult.reason
                            ? `\n\n**Agent note:** ${reviewResult.reason}`
                            : ""),
                });
                devResult.prUrl = pr.url;
                console.log(`[orchestrator:postProcess] [${jobId}] PR #${pr.number} opened: ${pr.url}`);
            } catch (err) {
                console.error(`[orchestrator:postProcess] [${jobId}] PR creation failed:`, err);
                // Non-fatal — we still mark the job done and teardown
            }
        } else {
            console.warn(`[orchestrator:postProcess] [${jobId}] Skipping PR — verdict is FAIL`);
        }

        finishJob(jobId, "done");
        console.log(`[orchestrator:postProcess] [${jobId}] Pushing branch and tearing down workspace...`);
        await pushAndTeardown(workspace);
        console.log(`[orchestrator:postProcess] [${jobId}] Job complete`);
        return {};
    };
}

// ---------------------------------------------------------------------------
// 7. teardown  (error path)
//    Called when any earlier node sets state.error. Removes the workspace
//    clone without pushing. Marks the job as failed in the registry.
// ---------------------------------------------------------------------------

export function makeTeardownNode(): NodeFn {
    return async (state) => {
        const { jobId, workspace, error } = state;
        console.error(`[orchestrator:teardown] [${jobId}] Error path — reason: ${error}`);

        finishJob(jobId, "failed");

        if (workspace) {
            console.log(`[orchestrator:teardown] [${jobId}] Removing workspace clone (no push)`);
            await teardownWorkspace(workspace);
        } else {
            console.log(`[orchestrator:teardown] [${jobId}] No workspace to clean up`);
        }

        return {};
    };
}
