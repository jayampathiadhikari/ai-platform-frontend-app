import type { JiraTicket } from "../context-provider/types.js";

export interface AgentDirective {
    repoUrl: string;
    baseBranch: string;
}

export interface WorkspaceContext {
    jobId: string;
    jiraId: string;
    ticket: JiraTicket;
    directive: AgentDirective;
    workspacePath: string;
}