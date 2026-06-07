export interface CreatePullRequestOptions {
    /** Full remote URL of the repo (HTTPS). Used to derive owner/repo. */
    remoteUrl: string;
    /** Branch containing the changes. */
    head: string;
    /** Branch to merge into. */
    base: string;
    title: string;
    body?: string;
}

export interface PullRequestResult {
    url: string;
    number: number;
}

/**
 * Opens a GitHub pull request via the REST API.
 * Requires the GITHUB_TOKEN environment variable to be set.
 */
export async function createPullRequest(
    opts: CreatePullRequestOptions
): Promise<PullRequestResult> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error("GITHUB_TOKEN is not set");
    }

    const { owner, repo } = parseOwnerRepo(opts.remoteUrl);

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            body: JSON.stringify({
                title: opts.title,
                body: opts.body ?? "",
                head: opts.head,
                base: opts.base,
            }),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(
            `GitHub API error ${response.status} creating PR: ${text}`
        );
    }

    const data = (await response.json()) as { html_url: string; number: number };
    return { url: data.html_url, number: data.number };
}

/**
 * Extracts { owner, repo } from a GitHub remote URL.
 * Handles HTTPS URLs, token-embedded URLs, and .git suffixes.
 *
 * Examples:
 *   https://github.com/owner/repo.git  → { owner: "owner", repo: "repo" }
 *   https://x-access-token:TOKEN@github.com/owner/repo → same
 */
function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string } {
    // Strip any embedded credentials (https://token@github.com/...)
    const clean = remoteUrl.replace(/https?:\/\/[^@]+@/, "https://");
    const match = clean.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
        throw new Error(`Cannot parse owner/repo from remote URL: ${remoteUrl}`);
    }
    return { owner: match[1]!, repo: match[2]! };
}
