

import type { WorkspaceContext } from "./types.js";
import { parseAgentDirective, createWorkspaceDir } from "./helpers.js";
import { mockJiraTickets } from "../context-provider/mock-jira-tickets.js";

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Takes a Jira ticket ID and a job ID, resolves the ticket, parses the
 * @agent directive, and creates a fresh temp workspace directory.
 *
 * Returns a WorkspaceContext with everything the dev-agent needs to start work.
 */
export async function runJob(
    jiraId: string,
    jobId: string
): Promise<WorkspaceContext> {
    // 1. Resolve ticket
    const ticket = mockJiraTickets.find((t) => t.id === jiraId);
    if (!ticket) {
        throw new Error(`Jira ticket "${jiraId}" not found.`);
    }

    // 2. Parse @agent directive
    const directive = parseAgentDirective(ticket);
    if (!directive) {
        throw new Error(
            `No valid @agent directive found in comments for ticket "${jiraId}".`
        );
    }

    // 3. Create temp workspace
    const workspacePath = await createWorkspaceDir(jobId);

    const ctx: WorkspaceContext = {
        jobId,
        jiraId,
        ticket,
        directive,
        workspacePath,
    };

    console.log(`[orchestrator] Job "${jobId}" initialised`);
    console.log(`  Ticket   : ${ticket.id} — ${ticket.title}`);
    console.log(`  Repo     : ${directive.repoUrl}`);
    console.log(`  Branch   : ${directive.checkoutBranch}`);
    console.log(`  Workspace: ${workspacePath}`);

    return ctx;
}
