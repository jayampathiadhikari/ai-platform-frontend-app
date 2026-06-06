import { execFile } from "child_process";
import { promisify } from "util";
import type { GitResult, GitCloneOptions } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Clone a remote repository into a local directory.
 *
 * @param repoUrl  - Remote URL (HTTPS or SSH).
 * @param options  - Optional clone flags.
 * @param cwd      - Working directory from which to run the clone.
 */
export async function gitClone(
    repoUrl: string,
    options: GitCloneOptions = {},
    cwd?: string
): Promise<GitResult> {
    const args = ["clone"];

    if (options.branch) {
        args.push("--branch", options.branch);
    }
    if (options.depth !== undefined) {
        args.push("--depth", String(options.depth));
    }

    args.push(repoUrl);

    if (options.targetDir) {
        args.push(options.targetDir);
    }

    return git(args, cwd);
}

/**
 * Checkout an existing branch (or tag / commit) in the given repo.
 *
 * @param branchOrRef - Branch name, tag, or commit SHA to check out.
 * @param repoDir     - Absolute path to the local repository.
 */
export async function gitCheckout(
    branchOrRef: string,
    repoDir: string
): Promise<GitResult> {
    return git(["checkout", branchOrRef], repoDir);
}

/**
 * Create a new branch and immediately check it out.
 * Equivalent to `git checkout -b <branch> [<startPoint>]`.
 *
 * @param branchName - Name of the new branch.
 * @param repoDir    - Absolute path to the local repository.
 * @param startPoint - Optional base ref (commit, tag, or branch). Defaults to HEAD.
 */
export async function gitCreateAndCheckout(
    branchName: string,
    repoDir: string,
    startPoint?: string
): Promise<GitResult> {
    const args = ["checkout", "-b", branchName];
    if (startPoint) args.push(startPoint);
    return git(args, repoDir);
}

// ---------------------------------------------------------------------------
// Internal runner
// ---------------------------------------------------------------------------

async function git(args: string[], cwd?: string): Promise<GitResult> {
    try {
        const { stdout, stderr } = await execFileAsync("git", args, {
            cwd,
            // Prevent git from spawning a pager or prompting for credentials
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
        return { stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err: unknown) {
        const message =
            err instanceof Error ? err.message : String(err);
        throw new Error(`git ${args[0]} failed: ${message}`);
    }
}