import type { JiraTicket } from "./types.js";

export const mockJiraTickets: JiraTicket[] = [
    {
        id: "PROJ-101",
        title: "Fix authentication token refresh race condition",
        description:
            "When multiple API requests fire simultaneously before the access token expires, " +
            "the token refresh endpoint is called multiple times in parallel. This causes " +
            "some requests to fail with 401 after receiving an invalidated token. " +
            "Implement a mutex/queue pattern so only one refresh call is in-flight at a time.",
        acceptanceCriteria: [
            "Only one token refresh request is made when concurrent requests detect an expired token.",
            "Subsequent requests are queued and retried with the new token once refresh completes.",
            "Existing unit tests for the auth module continue to pass.",
            "A regression test is added that simulates concurrent 401 responses.",
        ],
        status: "To Do",
        priority: "High",
        comments: [
            {
                id: "c1-1",
                author: "jane.doe",
                body: "Confirmed this in production logs — happens under load when >5 req/s.",
                createdAt: "2026-06-01T09:15:00Z",
            },
            {
                id: "c1-2",
                author: "agent-bot",
                body: `@agent
repo-url: "https://github.com/acme/backend-api",
checkout-branch: "fix/auth-token-refresh-race"`,
                createdAt: "2026-06-02T10:00:00Z",
            },
        ],
    },
    {
        id: "PROJ-102",
        title: "Add pagination to /api/products endpoint",
        description:
            "The GET /api/products endpoint currently returns all products in a single response. " +
            "As the catalogue grows this is causing slow load times and high memory usage on the server. " +
            "Add cursor-based pagination support with `limit` and `cursor` query parameters.",
        acceptanceCriteria: [
            "Endpoint accepts `limit` (default 20, max 100) and `cursor` query params.",
            "Response includes `data`, `nextCursor`, and `hasMore` fields.",
            "When `cursor` is omitted the first page is returned.",
            "Invalid `limit` values return a 400 with a descriptive error message.",
            "API documentation (OpenAPI spec) is updated to reflect the new parameters.",
        ],
        status: "In Progress",
        priority: "Medium",
        comments: [
            {
                id: "c2-1",
                author: "john.smith",
                body: "Should we use cursor-based or offset-based? Cursor is better for real-time data.",
                createdAt: "2026-06-03T14:22:00Z",
            },
            {
                id: "c2-2",
                author: "jane.doe",
                body: "Agreed — cursor-based. Let's use the `createdAt` timestamp + id composite as the cursor.",
                createdAt: "2026-06-03T15:05:00Z",
            },
            {
                id: "c2-3",
                author: "agent-bot",
                body: `@agent
repo-url: "https://github.com/acme/backend-api",
checkout-branch: "feature/products-pagination"`,
                createdAt: "2026-06-04T08:30:00Z",
            },
        ],
    },
    {
        id: "PROJ-103",
        title: "Migrate user preferences storage from localStorage to server-side",
        description:
            "User preferences (theme, language, notification settings) are currently persisted " +
            "only in localStorage. This means preferences are lost when users switch devices or " +
            "clear their browser data. Preferences should be stored in the user profile table " +
            "and synced on login.",
        acceptanceCriteria: [
            "A `preferences` JSONB column is added to the `users` table via a migration.",
            "GET /api/me returns a `preferences` object.",
            "PATCH /api/me/preferences updates one or more preference keys atomically.",
            "On initial login, server preferences are merged over any existing localStorage values.",
            "localStorage is used as a local cache and is invalidated on logout.",
            "All existing preference-related frontend tests pass without modification.",
        ],
        status: "To Do",
        priority: "Medium",
        comments: [
            {
                id: "c3-1",
                author: "alice.chen",
                body: "We should also handle the migration for existing users — default preferences on first sync.",
                createdAt: "2026-06-05T11:00:00Z",
            },
            {
                id: "c3-2",
                author: "agent-bot",
                body: `@agent
repo-url: "https://github.com/acme/frontend-app",
checkout-branch: "feature/server-side-preferences"`,
                createdAt: "2026-06-05T12:45:00Z",
            },
        ],
    },
    {
        id: "PROJ-104",
        title: "Scaffold new Next.js project with TypeScript and HeroUI",
        description:
            "Bootstrap a brand-new Next.js application using the App Router, TypeScript, and HeroUI " +
            "as the component library. The project will serve as the foundation for the customer-facing " +
            "dashboard. It must be set up with sensible defaults (ESLint, path aliases, Tailwind CSS " +
            "required by HeroUI) so future feature tickets can be picked up immediately without " +
            "environment friction.",
        acceptanceCriteria: [
            "Project is initialised with `create-next-app` using the App Router and TypeScript template.",
            "HeroUI and its peer dependencies (Tailwind CSS, framer-motion) are installed and configured.",
            "`tailwind.config.ts` includes the HeroUI plugin and content paths.",
            "A sample page renders at least one HeroUI component (e.g. <Button>) to prove the setup works.",
            "Path alias `@/` resolves to the `src/` directory in both `tsconfig.json` and `next.config.ts`.",
            "The dev server starts with `npm run dev` and displays no console errors.",
            "A `README.md` documents the tech stack and how to run the project locally.",
        ],
        status: "To Do",
        priority: "High",
        comments: [
            {
                id: "c4-1",
                author: "agent-bot",
                body: `@agent
                repo-url: "https://github.com/jayampathiadhikari/ai-platform-frontend-app",
                checkout-branch: "master"`,
                createdAt: "2026-06-06T09:00:00Z",
            },
        ],
    },
];
