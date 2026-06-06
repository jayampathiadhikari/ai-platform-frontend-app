import type { AgentDirective } from "./types.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import type { JiraTicket } from "../context-provider/types.js";

/**
 * Parses the first @agent comment block found in a ticket's comments.
 *
 * Expected format (leading whitespace is trimmed):
 *   @agent
 *   repo-url: "...",
 *   checkout-branch: "..."
 */
export function parseAgentDirective(ticket: JiraTicket): AgentDirective | null {
    for (const comment of ticket.comments) {
        const body = comment.body.trim();
        if (!body.startsWith("@agent")) continue;

        const repoMatch = body.match(/repo-url:\s*"([^"]+)"/);
        const branchMatch = body.match(/base-branch:\s*"([^"]+)"/);

        if (!repoMatch || !branchMatch) continue;

        return {
            repoUrl: repoMatch[1]!,
            baseBranch: branchMatch[1]!,
        };
    }
    return null;
}

/**
 * Creates an isolated temp workspace directory for a job.
 * Path: <os.tmpdir()>/ai-agent-workspaces/<jobId>
 */
export async function createWorkspaceDir(jobId: string): Promise<string> {
    const workspacePath = path.join(
        os.tmpdir(),
        "ai-agent-workspaces",
        jobId
    );
    await fs.mkdir(workspacePath, { recursive: true });
    return workspacePath;
}