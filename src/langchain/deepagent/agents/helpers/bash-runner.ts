import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { checkBashGuard } from "../../guardrails/bash-guard.js";

const execAsync = promisify(exec);

// URL of the executor sidecar (set in Docker / ECS environments).
// When absent, bash commands run directly in the agent process (local dev without Docker).
export const EXECUTOR_URL = process.env.EXECUTOR_URL?.replace(/\/$/, ""); // strip trailing slash

// ---------------------------------------------------------------------------
// runViaExecutor
// ---------------------------------------------------------------------------
// When EXECUTOR_URL is set (Docker / ECS), commands are forwarded to the
// executor sidecar over HTTP. The sidecar has no AWS credentials and runs
// in an isolated container — this is the sandbox boundary.
// ---------------------------------------------------------------------------

export async function runViaExecutor(
    command: string,
    cwd: string,
    timeout: number
): Promise<string> {
    const url = `${EXECUTOR_URL}/exec`;
    let res: Response;
    try {
        res = await fetch(url, {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ command, cwd, timeout }),
            signal:  AbortSignal.timeout(timeout + 5_000), // extra buffer for HTTP round-trip
        });
    } catch (err) {
        return `ERROR: Executor sidecar unreachable at ${url} — ${err instanceof Error ? err.message : String(err)}`;
    }

    if (!res.ok) {
        const text = await res.text().catch(() => "(no body)");
        return `ERROR: Executor returned HTTP ${res.status}: ${text}`;
    }

    const json = await res.json() as { stdout?: string; stderr?: string; exitCode?: number };
    const out = [json.stdout, json.stderr].filter(Boolean).join("\n---stderr---\n");
    const prefix = (json.exitCode ?? 0) !== 0 ? `[exit ${json.exitCode}] ` : "";
    return prefix + (out || "(no output)");
}

// ---------------------------------------------------------------------------
// runLocally
// ---------------------------------------------------------------------------
// When EXECUTOR_URL is absent (plain `npm run dev`), commands run directly
// in the agent process — convenient for local dev without Docker.
// ---------------------------------------------------------------------------

export async function runLocally(
    command: string,
    cwd: string,
    timeout: number
): Promise<string> {
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout,
            maxBuffer: 10 * 1024 * 1024,
        });
        const out = [stdout, stderr].filter(Boolean).join("\n---stderr---\n");
        return out || "(no output)";
    } catch (err: unknown) {
        const e = err as { message?: string; stdout?: string; stderr?: string };
        return `ERROR: ${e.message ?? String(err)}\n${e.stderr ?? ""}`.trim();
    }
}

// ---------------------------------------------------------------------------
// makeBashTool — workspace-scoped bash tool factory
// ---------------------------------------------------------------------------

export function makeBashTool(cwd: string) {
    return tool(
        async ({ command, timeout }: { command: string; timeout?: number }) => {
            const guard = checkBashGuard(command);
            if (guard.blocked) {
                console.warn(`[deepagent:bash] Blocked: ${command.slice(0, 120)}\n  Reason: ${guard.reason}`);
                return `BLOCKED: ${guard.reason}`;
            }

            const effectiveTimeout = timeout ?? 30_000;

            if (EXECUTOR_URL) {
                // ── Sandboxed path: route through executor sidecar ──────────
                console.log(`[deepagent:bash] → executor: ${command.slice(0, 200)}`);
                return runViaExecutor(command, cwd, effectiveTimeout);
            } else {
                // ── Local dev path: run directly (no Docker) ───────────────
                console.log(`[deepagent:bash] local: ${command.slice(0, 200)}`);
                return runLocally(command, cwd, effectiveTimeout);
            }
        },
        {
            name: "bash",
            description:
                "Run a bash shell command inside the workspace directory. " +
                "Use for git, npm, running tests, etc. " +
                "Dangerous commands (sudo, force-push, rm -rf /, curl|sh, etc.) are blocked.",
            schema: z.object({
                command: z.string().describe("The bash command to execute"),
                timeout: z.number().optional().default(30_000).describe("Timeout in milliseconds"),
            }),
        }
    );
}
