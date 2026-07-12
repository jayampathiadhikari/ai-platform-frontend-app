import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import type { JiraStory, Workspace } from "./types.js";

import {
    buildRemoteUrl,
    isEmptyRepoError,
    bootstrapEmptyRepo,
    removeClone,
    GIT_BRANCH_PREFIX,
} from "./helpers.js";
import { gitClone, gitConfig, gitCreateAndCheckout, gitPush } from "../git/git.js";

const JOBS_DIR = process.env.JOBS_DIR ?? "/workspace/jobs";

/**
 * Clones the repo fresh for each job and checks out a new agent branch.
 * No shared state with any other job — the clone is fully self-contained.
 *
 * Layout on disk:
 *   <JOBS_DIR>/
 *     job-<storyId>-<ts>/   ← repo root, single job, deleted on teardown
 */
export async function setupWorkspace(story: JiraStory): Promise<Workspace> {
    const jobId = `job-${story.id}-${Date.now()}`;
    const jobDir = path.join(JOBS_DIR, jobId);
    const branch = `${GIT_BRANCH_PREFIX}${jobId}`;
    const remoteUrl = buildRemoteUrl(story.repoUrl);

    console.log(`[workspace] [${jobId}] Ensuring jobs dir exists: ${JOBS_DIR}`);
    await fs.mkdir(JOBS_DIR, { recursive: true });

    console.log(`[workspace] [${jobId}] Cloning ${story.repoUrl}@${story.baseBranch} → ${jobDir} (depth=1)`);
    let emptyRepoBootstrapped = false;
    try {
        await gitClone(remoteUrl, {
            branch: story.baseBranch,
            depth: 1,
            singleBranch: true,
            targetDir: jobDir,
        });
        console.log(`[workspace] [${jobId}] Clone complete`);
    } catch (err) {
        if (!isEmptyRepoError(err)) throw err;
        console.warn(`[workspace] [${jobId}] Remote is empty — bootstrapping base branch "${story.baseBranch}"`);
        await bootstrapEmptyRepo(remoteUrl, jobDir, story.baseBranch, branch, jobId);
        emptyRepoBootstrapped = true;
    }

    if (!emptyRepoBootstrapped) {
        console.log(`[workspace] [${jobId}] Configuring git identity`);
        await gitConfig("user.email", "agent@yourplatform.io", jobDir);
        await gitConfig("user.name", "Agent Bot", jobDir);

        console.log(`[workspace] [${jobId}] Creating and checking out branch: ${branch}`);
        await gitCreateAndCheckout(branch, jobDir);
    }

    // Make the entire job directory tree world-writable so the executor sidecar
    // (runs as node user) can read/write/git anywhere in the repo. This MUST run
    // AFTER gitCreateAndCheckout — that call creates .git/refs/heads/agent/ as
    // root (755), and we need it world-writable before the executor commits.
    execSync(`chmod -R 777 "${jobDir}"`);
    console.log(`[workspace] [${jobId}] jobDir chmod -R 777 — executor can now write`);

    console.log(`[workspace] [${jobId}] Writing TASK.md and CLAUDE.md`);
    await fs.writeFile(path.join(jobDir, "TASK.md"), story.taskMd, "utf8");
    await fs.writeFile(path.join(jobDir, "CLAUDE.md"), story.claudeMd, "utf8");
    const claudeHash = createHash("sha256").update(story.claudeMd).digest("hex").slice(0, 8);
    console.log(`[workspace] [${jobId}] CLAUDE.md written — sha256=${claudeHash} (${story.claudeMd.length} bytes)`);

    console.log(`[workspace] [${jobId}] Ready on branch ${branch}`);
    return { jobId, jobDir, branch, repo: story.repoUrl, remoteUrl };
}

/**
 * Pushes the agent branch to GitHub then removes the local clone.
 * Push is done here (not inside the agent) so we control timing and the agent
 * doesn't need network access mid-session.
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
 * Teardown without push — used when the job failed and we don't want to push
 * a broken branch to GitHub.
 */
export async function teardownWorkspace(workspace: Workspace): Promise<void> {
    console.log(`[workspace] [${workspace.jobId}] Tearing down workspace (no push)`);
    await removeClone(workspace.jobDir, workspace.jobId);
}