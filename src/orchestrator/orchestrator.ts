

import fs from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import type { AgentDirective } from "./types.js";
import { parseAgentDirective } from "./helpers.js";
import { MockJiraContextProvider } from "../context-provider/context-provider.js";
import type { ContextProvider } from "../context-provider/types.js";
import type { JiraStory, Workspace } from "../workspace-manager/types.js";
import { setupWorkspace } from "../workspace-manager/workspace-manager.js";
import type { Agent, JobResult } from "../agents/types.js";
import { DevAgent } from "../agents/dev-agent.js";
import { createPullRequest } from "../git/github.js";

const CLAUDE_MD_PATH = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../agents/CLAUDE.md"
);


/**
 * Takes a Jira ticket ID and a job ID, resolves the ticket, parses the
 * @agent directive, and creates a fresh temp workspace directory.
 *
 * Returns a WorkspaceContext with everything the dev-agent needs to start work.
 */
export async function runJob(
    jiraId: string,
    jobId: string,
    contextProvider: ContextProvider = new MockJiraContextProvider()
): Promise<void> {
    // 1. Resolve ticket
    const ticket = await contextProvider.getTicket(jiraId);
    if (!ticket) {
        throw new Error(`Jira ticket "${jiraId}" not found.`);
    }

    // 2. Load agent operational guidelines
    const claudeMd = await fs.readFile(CLAUDE_MD_PATH, "utf8");

    // 3. Parse @agent directive
    const directive: AgentDirective | null = parseAgentDirective(ticket);
    if (!directive) {
        throw new Error(
            `No valid @agent directive found in comments for ticket "${jiraId}".`
        );
    }

    const jiraStory: JiraStory = {
        id: ticket.id,
        projectId: "project-1",
        tenantId: "tenant",
        repoUrl: directive.repoUrl,
        baseBranch: directive.baseBranch,
        taskMd: ticket.description,
        claudeMd,
        description: ticket.description,
        retryCount: 0,
        checkpointRef: "",
    };

    const workspace = await setupWorkspace(jiraStory);

    const agent: Agent = new DevAgent();
    const result: JobResult = await agent.run(jiraStory, workspace);

    await postProcess(jiraStory, workspace, result);

    console.log("[orchestrator] Job result: ", result);
}

/**
 * Runs after the agent completes. Responsible for any side-effects that depend
 * on the job outcome — currently opens a GitHub PR for non-failing verdicts.
 */
async function postProcess(
    story: JiraStory,
    workspace: Workspace,
    result: JobResult
): Promise<void> {
    if (result.verdict === "PASS" || result.verdict === "PARTIAL") {
        try {
            const pr = await createPullRequest({
                remoteUrl: workspace.remoteUrl,
                head: workspace.branch,
                base: story.baseBranch,
                title: `[${story.id}] ${story.description}`,
                body: `Automated implementation of Jira story ${story.id}.${
                    result.reason ? `\n\n**Agent note:** ${result.reason}` : ""
                }`,
            });
            result.prUrl = pr.url;
            console.log(`[orchestrator] PR opened: ${pr.url}`);
        } catch (err) {
            console.error(`[orchestrator] Failed to open PR for ${workspace.jobId}:`, err);
        }
    } else {
        console.warn(`[orchestrator] Skipping PR — verdict is FAIL for ${workspace.jobId}`);
    }
}
