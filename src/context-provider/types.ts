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