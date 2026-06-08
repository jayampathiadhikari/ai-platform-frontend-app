/**
 * LangChain Bash tool — executes shell commands inside the job worktree
 * and enforces the same blocklist as src/agents/guardrails/bash-guard.ts.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import { checkBashCommand } from "../guardrails/bash-guard.js";

const execFileAsync = promisify(execFile);

/** Timeout for a single bash command (ms) — guards against runaway processes. */
const COMMAND_TIMEOUT_MS = 120_000;

/**
 * Returns a Bash tool scoped to the given working directory.
 */
export function createBashTool(cwd: string) {
    return tool(
        async ({ command }: { command: string }) => {
            // ── Safety check ────────────────────────────────────────────
            const guardResult = checkBashCommand(command);
            if (guardResult.blocked) {
                console.warn(`[bash-tool] Blocked command: ${command.slice(0, 120)}\n  Reason: ${guardResult.reason}`);
                return `Command blocked: ${guardResult.reason}`;
            }

            // ── Execute ──────────────────────────────────────────────────
            try {
                const { stdout, stderr } = await execFileAsync(
                    process.platform === "win32" ? "cmd" : "bash",
                    process.platform === "win32" ? ["/c", command] : ["-c", command],
                    {
                        cwd,
                        timeout: COMMAND_TIMEOUT_MS,
                        maxBuffer: 10 * 1024 * 1024, // 10 MB
                    }
                );

                const out = [stdout, stderr].filter(Boolean).join("\n").trim();
                return out || "(command produced no output)";
            } catch (err: unknown) {
                if ((err as NodeJS.ErrnoException).killed) {
                    return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`;
                }
                // Include stderr in the returned string so the agent can see what went wrong
                const e = err as { stdout?: string; stderr?: string; message?: string };
                const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim();
                return `Command failed:\n${detail}`;
            }
        },
        {
            name: "Bash",
            description:
                "Run a shell command in the workspace root. " +
                "Avoid destructive, privilege-escalating, or network-fetching commands — they will be blocked. " +
                "Use for git operations, running tests, and build commands.",
            schema: z.object({
                command: z.string().describe("The shell command to execute."),
            }),
        }
    );
}
