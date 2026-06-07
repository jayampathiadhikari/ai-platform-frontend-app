import type { ContextProvider, JiraTicket } from "./types.js";
import { mockJiraTickets } from "./mock-jira-tickets.js";

export class MockJiraContextProvider implements ContextProvider {
    private readonly tickets: JiraTicket[];

    constructor(tickets: JiraTicket[] = mockJiraTickets) {
        this.tickets = tickets;
    }

    async getTicket(id: string): Promise<JiraTicket | undefined> {
        return this.tickets.find((t) => t.id === id);
    }

    async listTickets(filter?: { status?: JiraTicket["status"] }): Promise<JiraTicket[]> {
        if (filter?.status === undefined) {
            return this.tickets;
        }
        return this.tickets.filter((t) => t.status === filter.status);
    }
}
