import fs from "fs/promises";
import { gitClone, gitConfig, gitCreateAndCheckout, gitCommit, gitPush } from "../git/git.js";
import { GIT_BRANCH_PREFIX } from "../constants.js";

// ---------------------------------------------------------------------------
// Remote URL
// ---------------------------------------------------------------------------

/**
 * Injects a GitHub token into a repo URL so git doesn't prompt for credentials.
 * e.g. https://github.com/org/repo → https://x-access-token:<token>@github.com/org/repo
 *
 * The authenticated URL is only used inside the isolated job directory — never logged.
 */
export function buildRemoteUrl(repoUrl: string): string {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN env var is required");

    const parsed = new URL(repoUrl);
    parsed.username = "x-access-token";
    parsed.password = token;
    return parsed.toString();
}

// ---------------------------------------------------------------------------
// Empty-repo detection & bootstrap
// ---------------------------------------------------------------------------

/**
 * Returns true when a clone error is caused by a completely empty remote
 * (the repo exists on GitHub but has never had a commit pushed).
 */
export function isEmptyRepoError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return (
        (msg.includes("Remote branch") && msg.includes("not found in upstream"))
        || msg.includes("remote HEAD refers to nonexistent ref")
        || msg.includes("You appear to have cloned an empty repository")
    );
}

/**
 * Handles the empty-remote case:
 *  1. Clone the bare empty repo (no --branch / --depth so git doesn't error)
 *  2. Set git identity (required before committing)
 *  3. Create the base branch with an empty initial commit
 *  4. Push it to origin so it exists for future PRs
 *  5. Create and checkout the agent working branch
 */
export async function bootstrapEmptyRepo(
    remoteUrl: string,
    jobDir: string,
    baseBranch: string,
    agentBranch: string,
    jobId: string
): Promise<void> {
    // Plain clone — succeeds even with no commits on the remote
    await gitClone(remoteUrl, { targetDir: jobDir });
    console.log(`[workspace-helpers] [${jobId}] Empty clone complete`);

    // Identity must be configured before we can commit
    await gitConfig("user.email", "agent@yourplatform.io", jobDir);
    await gitConfig("user.name", "Agent Bot", jobDir);

    // Create base branch and seed it with a single empty commit
    await gitCreateAndCheckout(baseBranch, jobDir);
    await gitCommit("chore: initial commit", jobDir, { allowEmpty: true });

    // Push base branch to origin so the remote reference exists
    await gitPush(baseBranch, jobDir, "origin", true /* --set-upstream */);
    console.log(`[workspace-helpers] [${jobId}] Base branch "${baseBranch}" pushed to origin`);

    // Create the agent working branch off the freshly pushed base
    await gitCreateAndCheckout(agentBranch, jobDir);
    console.log(`[workspace-helpers] [${jobId}] Agent branch "${agentBranch}" created off "${baseBranch}"`);
}

// ---------------------------------------------------------------------------
// Filesystem cleanup
// ---------------------------------------------------------------------------

/**
 * Recursively removes a job clone directory. Errors are swallowed so teardown
 * always completes regardless of filesystem state.
 */
export async function removeClone(jobDir: string, jobId: string): Promise<void> {
    try {
        await fs.rm(jobDir, { recursive: true, force: true });
        console.log(`[workspace-helpers] [${jobId}] Clone removed`);
    } catch (err) {
        console.warn(`[workspace-helpers] [${jobId}] rm failed:`, err);
    }
}

// Re-export for consumers that only need the prefix constant in context
export { GIT_BRANCH_PREFIX };
