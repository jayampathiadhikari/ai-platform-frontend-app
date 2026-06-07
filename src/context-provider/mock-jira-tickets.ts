import type { JiraTicket } from "./types.js";

export const mockJiraTickets: JiraTicket[] = [
    {
        id: "PROJ-105",
        title: "Create a simple Node.js Express server with a hello-world test endpoint",
        description:
            "Initialise a minimal Node.js project and add an Express HTTP server. " +
            "The server must expose a single test endpoint GET /health that returns " +
            "a JSON response { \"status\": \"ok\", \"message\": \"Hello, World!\" }. " +
            "The project should use npm, include a start script, and be runnable with `npm start`. " +
            "No tests required.",
        acceptanceCriteria: [
            "Running `npm start` starts the server with no errors.",
        ],
        status: "To Do",
        priority: "Low",
        comments: [
            {
                id: "c5-1",
                author: "agent-bot",
                body: `@agent
repo-url: "https://github.com/jayampathiadhikari/ai-api-test-agent",
base-branch: "master"`,
                createdAt: "2026-06-08T00:00:00Z",
            },
        ],
    },
];
