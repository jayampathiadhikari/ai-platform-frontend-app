export interface JiraComment {
    id: string;
    author: string;
    body: string;
    createdAt: string;
}

export interface JiraTicket {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    comments: JiraComment[];
    status: "To Do" | "In Progress" | "In Review" | "Done";
    priority: "Low" | "Medium" | "High" | "Critical";
}

export interface ContextProvider {
    /**
     * Fetch a single ticket by its ID.
     * Returns undefined if the ticket does not exist.
     */
    getTicket(id: string): Promise<JiraTicket | undefined>;

    /**
     * List tickets, optionally filtered by status.
     */
    listTickets(filter?: { status?: JiraTicket["status"] }): Promise<JiraTicket[]>;
}