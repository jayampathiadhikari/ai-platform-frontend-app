import fs from "fs/promises";
import path from "path";
import type { JiraStory, Workspace } from "./types.js";
import { gitClone, gitConfig, gitCreateAndCheckout, gitPush } from "../git/git.js";
import { GIT_BRANCH_PREFIX } from "../constants.js";

const JOBS_DIR = process.env.JOBS_DIR ?? "/workspace/jobs";


/**
 * Clones the repo fresh for each job and checks out a new agent branch.
 * No shared state with any other job — the clone is fully self-contained.
 *
 * Layout on disk:
 *   /workspace/jobs/
 *     job-<storyId>-<ts>/   ← full clone, single job, deleted on teardown
 */
export async function setupWorkspace(story: JiraStory): Promise<Workspace> {

    const jobId = `job-${story.id}-${Date.now()}`;
    const jobDir = path.join(JOBS_DIR, jobId);
    // Branch name: agent/<story-id> — predictable, shows up clearly in GitHub PR list
    const branch = `${GIT_BRANCH_PREFIX}${story.id}`;
    const remoteUrl = buildRemoteUrl(story.repoUrl);

    console.log(`[workspace] [${jobId}] Ensuring jobs dir exists: ${JOBS_DIR}`);
    await fs.mkdir(JOBS_DIR, { recursive: true });

    console.log(`[workspace] [${jobId}] Cloning ${story.repoUrl}@${story.baseBranch} → ${jobDir} (depth=1)`);
    await gitClone(remoteUrl, {
        branch: story.baseBranch,
        depth: 1,
        singleBranch: true,
        targetDir: jobDir,
    });
    console.log(`[workspace] [${jobId}] Clone complete`);

    console.log(`[workspace] [${jobId}] Configuring git identity`);
    await gitConfig("user.email", "agent@yourplatform.io", jobDir);
    await gitConfig("user.name", "Agent Bot", jobDir);

    console.log(`[workspace] [${jobId}] Creating and checking out branch: ${branch}`);
    await gitCreateAndCheckout(branch, jobDir);

    console.log(`[workspace] [${jobId}] Writing TASK.md (${story.taskMd.length} bytes) and CLAUDE.md (${story.claudeMd.length} bytes)`);
    await fs.writeFile(path.join(jobDir, "TASK.md"), story.taskMd, "utf8");
    await fs.writeFile(path.join(jobDir, "CLAUDE.md"), story.claudeMd, "utf8");

    console.log(`[workspace] [${jobId}] Ready on branch ${branch}`);
    return { jobId, jobDir, branch, repo: story.repoUrl, remoteUrl };
}

/**
 * Pushes the agent branch to GitHub then removes the local clone.
 * Called from the finally block in worker.ts — always runs even on failure.
 *
 * Push happens here (not inside the agent) so:
 *  - The agent only needs local git access (simpler bash permissions)
 *  - We control when the push happens — after verdict, not mid-session
 *  - A failed push doesn't leave the agent confused mid-task
 */
export async function pushAndTeardown(workspace: Workspace): Promise<void> {
    console.log(`[workspace] [${workspace.jobId}] Pushing branch ${workspace.branch}...`);
    try {
        await gitPush(workspace.branch, workspace.jobDir);
        console.log(`[workspace] [${workspace.jobId}] Push successful`);
    } catch (err) {
        console.error(`[workspace] [${workspace.jobId}] Push failed — proceeding with teardown:`, err);
    }

    await removeClone(workspace.jobDir, workspace.jobId);
}

/**
 * Teardown without push — used when job failed and we don't want to push
 * a broken branch to GitHub.
 */
export async function teardownWorkspace(workspace: Workspace): Promise<void> {
    console.log(`[workspace] [${workspace.jobId}] Tearing down workspace (no push)`);
    await removeClone(workspace.jobDir, workspace.jobId);
}

async function removeClone(jobDir: string, jobId: string): Promise<void> {
    try {
        await fs.rm(jobDir, { recursive: true, force: true });
        console.log(`[workspace] Removed clone ${jobId}`);
    } catch (err) {
        console.warn(`[workspace] rm failed for ${jobId}:`, err);
    }
}

function buildRemoteUrl(repoUrl: string): string {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN env var is required");

    // Inject the token into the provided URL so git doesn't prompt for credentials.
    // e.g. https://github.com/org/repo  →  https://x-access-token:<token>@github.com/org/repo
    // The authenticated URL is only used inside the isolated job directory — never logged.
    const parsed = new URL(repoUrl);
    parsed.username = "x-access-token";
    parsed.password = token;
    return parsed.toString();
}