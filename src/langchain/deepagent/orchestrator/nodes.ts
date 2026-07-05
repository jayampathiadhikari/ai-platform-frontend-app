/**
 * nodes.ts — Every node in the Deep Agent LangGraph orchestration pipeline.
 *
 * This orchestrator uses the official `deepagents` SDK (`createDeepAgent`)
 * for the developer agent node. The `deepagents` harness automatically provides:
 *   - write_todos task planning
 *   - Virtual filesystem (read_file, write_file, edit_file, glob, grep, ls)
 *   - Context summarization for long-running tasks
 *   - Subagent delegation via the built-in `task` tool
 *   - Prompt caching (Anthropic models)
 *
 * Node order:
 *   resolveTicket → setupWorkspace → devAgent → reviewAgent → postProcess → __end__
 *
 * Error path (any node can set state.error):
 *   → teardown → __end__
 */

import { fileURLToPath } from "url";
import path              from "path";
import fs                from "fs/promises";

import type { GraphState }     from "./types.js";
import type { JiraStory }      from "../../../shared/workspace-manager/types.js";
import type { ContextProvider } from "../../../shared/context-provider/types.js";
import type { ReviewVerdict }  from "../../types.js";

import {
    setupWorkspace,
    pushAndTeardown,
    teardownWorkspace,
} from "../../../shared/workspace-manager/workspace-manager.js";
import { createPullRequest }   from "../../../shared/git/github.js";
import { finishJob }           from "../../../shared/job-registry.js";
import { parseAgentDirective } from "../../../claude-sdk/orchestrator/helpers.js";

import { DeepDevAgent } from "../agents/dev-agent.js";

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
        console.log(`[deep:resolveTicket] [${jobId}] Fetching ticket=${jiraId}`);

        const ticket = await contextProvider.getTicket(jiraId);
        if (!ticket) {
            const error = `Ticket "${jiraId}" not found`;
            console.error(`[deep:resolveTicket] [${jobId}] ${error}`);
            return { error };
        }

        const directive = parseAgentDirective(ticket);
        if (!directive) {
            const error = `No @agent directive found in comments for ticket "${jiraId}"`;
            console.error(`[deep:resolveTicket] [${jobId}] ${error}`);
            return { error };
        }

        const claudeMd = await fs.readFile(CLAUDE_MD_PATH, "utf8");
        console.log(`[deep:resolveTicket] [${jobId}] CLAUDE.md loaded (${claudeMd.length} bytes)`);

        const story: JiraStory = {
            id:           ticket.id,
            projectId:    "project-1",
            tenantId:     "tenant",
            repoUrl:      directive.repoUrl,
            baseBranch:   directive.baseBranch,
            taskMd:       ticket.description,
            claudeMd,
            description:  ticket.description,
            retryCount:   state.retryCount,
            checkpointRef: "",
        };

        console.log(`[deep:resolveTicket] [${jobId}] Resolved: ${story.id} — "${ticket.title}"`);
        return { story };
    };
}

// ---------------------------------------------------------------------------
// 2. setupWorkspace
//    Clones the repo, creates the agent branch, writes TASK.md / CLAUDE.md.
// ---------------------------------------------------------------------------

export function makeSetupWorkspaceNode(): NodeFn {
    return async (state) => {
        const { jobId, story } = state;
        if (!story) return { error: "setupWorkspace: story is missing from state" };

        console.log(`[deep:setupWorkspace] [${jobId}] Cloning repo and preparing workspace...`);
        try {
            const workspace = await setupWorkspace(story);
            console.log(
                `[deep:setupWorkspace] [${jobId}] Ready — ` +
                `dir=${workspace.jobDir} branch=${workspace.branch}`
            );
            return { workspace };
        } catch (err) {
            const error = `setupWorkspace failed: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[deep:setupWorkspace] [${jobId}]`, error);
            return { error };
        }
    };
}

// ---------------------------------------------------------------------------
// 3. devAgent
//    Runs the Deep Agent (`createDeepAgent` from the `deepagents` SDK) inside
//    the prepared workspace. The harness provides task planning, filesystem
//    tools, context management, and subagent delegation automatically.
//    On retry the same workspace/branch is reused so the agent can build on
//    its previous commits.
// ---------------------------------------------------------------------------

export function makeDevAgentNode(): NodeFn {
    return async (state) => {
        const { jobId, story, workspace, signal, retryCount } = state;
        if (!story)     return { error: "devAgent: story is missing from state" };
        if (!workspace) return { error: "devAgent: workspace is missing from state" };

        if (retryCount > 0) {
            console.log(`[deep:devAgent] [${jobId}] Retry #${retryCount}/${MAX_RETRIES}`);
        }

        console.log(`[deep:devAgent] [${jobId}] Handing off to DeepDevAgent (deepagents SDK)...`);
        try {
            const agent     = new DeepDevAgent();
            const devResult = await agent.run(story, workspace, signal);
            console.log(
                `[deep:devAgent] [${jobId}] Finished — ` +
                `verdict=${devResult.verdict} turns=${devResult.turns}`
            );
            return {
                devResult,
                retryCount: devResult.verdict === "FAIL" ? retryCount + 1 : retryCount,
            };
        } catch (err) {
            const error = `devAgent threw: ${err instanceof Error ? err.message : String(err)}`;
            console.error(`[deep:devAgent] [${jobId}]`, error);
            return { error };
        }
    };
}

// ---------------------------------------------------------------------------
// 4. reviewAgent  (pass-through stub)
//    The Deep Agent writes REVIEW.json itself (the SDK's planning + filesystem
//    tools make this reliable). This node promotes the dev verdict to reviewResult.
//    Replace the body with a ReviewAgent LLM call when desired.
// ---------------------------------------------------------------------------

export function makeReviewAgentNode(): NodeFn {
    return async (state) => {
        const { jobId, devResult } = state;
        if (!devResult) return { error: "reviewAgent: devResult is missing from state" };

        console.log(
            `[deep:reviewAgent] [${jobId}] ` +
            `Promoting devAgent verdict="${devResult.verdict}" as reviewResult`
        );

        const reviewResult: ReviewVerdict = {
            verdict: devResult.verdict,
            reason:  devResult.reason ?? "(no reason provided)",
        };

        return { reviewResult };
    };
}

// ---------------------------------------------------------------------------
// 5. postProcess
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
        console.log(`[deep:postProcess] [${jobId}] verdict=${verdict}`);

        if (verdict === "PASS" || verdict === "PARTIAL") {
            try {
                const pr = await createPullRequest({
                    remoteUrl: workspace.remoteUrl,
                    head:      workspace.branch,
                    base:      story.baseBranch,
                    title:     `[${story.id}] ${story.description}`,
                    body:
                        `Automated implementation of Jira story ${story.id} via Deep Agent SDK.` +
                        (reviewResult.reason
                            ? `\n\n**Agent note:** ${reviewResult.reason}`
                            : ""),
                });
                devResult.prUrl = pr.url;
                console.log(`[deep:postProcess] [${jobId}] PR #${pr.number} opened: ${pr.url}`);
            } catch (err) {
                console.error(`[deep:postProcess] [${jobId}] PR creation failed:`, err);
            }
        } else {
            console.warn(`[deep:postProcess] [${jobId}] Skipping PR — verdict is FAIL`);
        }

        finishJob(jobId, "done");
        console.log(`[deep:postProcess] [${jobId}] Pushing branch and tearing down workspace...`);
        await pushAndTeardown(workspace);
        console.log(`[deep:postProcess] [${jobId}] Job complete`);
        return {};
    };
}

// ---------------------------------------------------------------------------
// 6. teardown  (error path)
//    Called when any earlier node sets state.error.
// ---------------------------------------------------------------------------

export function makeTeardownNode(): NodeFn {
    return async (state) => {
        const { jobId, workspace, error } = state;
        console.error(`[deep:teardown] [${jobId}] Error path — reason: ${error}`);

        finishJob(jobId, "failed");

        if (workspace) {
            console.log(`[deep:teardown] [${jobId}] Removing workspace clone (no push)`);
            await teardownWorkspace(workspace);
        }

        return {};
    };
}
