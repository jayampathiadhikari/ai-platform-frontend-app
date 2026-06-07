

import type { AgentDirective } from "./types.js";
import { parseAgentDirective } from "./helpers.js";
import { mockJiraTickets } from "../context-provider/mock-jira-tickets.js";
import type { JiraStory } from "../workspace-manager/types.js";
import { setupWorkspace } from "../workspace-manager/workspace-manager.js";
import type { Agent, JobResult } from "../agents/types.js";
import { DevAgent } from "../agents/dev-agent.js";


/**
 * Takes a Jira ticket ID and a job ID, resolves the ticket, parses the
 * @agent directive, and creates a fresh temp workspace directory.
 *
 * Returns a WorkspaceContext with everything the dev-agent needs to start work.
 */
export async function runJob(
    jiraId: string,
    jobId: string
): Promise<void> {
    // 1. Resolve ticket
    const ticket = mockJiraTickets.find((t) => t.id === jiraId);
    if (!ticket) {
        throw new Error(`Jira ticket "${jiraId}" not found.`);
    }

    // 2. Parse @agent directive
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
        claudeMd: "",
        description: ticket.description,
        retryCount: 0,
        checkpointRef: "",
    };

    const workspace = await setupWorkspace(jiraStory);

    const agent: Agent = new DevAgent();
    const result: JobResult = await agent.run(jiraStory, workspace);

    console.log("[orchestrator] Job result: ", result);
}
