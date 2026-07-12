import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { checkBashGuard } from "../../guardrails/bash-guard.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// classifyAction — Option 2: semantic action label
// ---------------------------------------------------------------------------
// Maps a raw bash command to a human-readable action verb so logs show
// *what* the agent is doing, not just the raw shell string.
// ---------------------------------------------------------------------------

function classifyAction(command: string): string {
    const cmd = command.trim();
    // Git operations
    if (/\bgit\s+(commit|push|tag)/.test(cmd))  return "GIT:COMMIT/PUSH";
    if (/\bgit\s+(add|stage)/.test(cmd))        return "GIT:STAGE";
    if (/\bgit\s+(status|log|diff)/.test(cmd))  return "GIT:STATUS";
    if (/\bgit\s+/.test(cmd))                   return "GIT";
    // Package management
    if (/\bnpm\s+install\b/.test(cmd))          return "INSTALL";
    if (/\bnpm\s+(run|test|build|start)\b/.test(cmd)) return "RUN:NPM";
    if (/\bpip\s+install\b/.test(cmd))          return "INSTALL:PY";
    // File writes
    if (/\btee\b|>>?\s*\S+/.test(cmd) || /\bcat\s*>/.test(cmd)) return "WRITE";
    // File reads
    if (/\bcat\b|\bhead\b|\btail\b|\bless\b/.test(cmd))         return "READ";
    // Test / curl / verify
    if (/\bcurl\b/.test(cmd))                   return "HTTP";
    if (/\btest\b|\bjest\b|\bmocha\b|\bpytest\b/.test(cmd)) return "TEST";
    // Node / python / misc runners
    if (/\bnode\b/.test(cmd))                   return "RUN:NODE";
    if (/\bpython\b/.test(cmd))                 return "RUN:PY";
    if (/\bmkdir\b/.test(cmd))                  return "MKDIR";
    if (/\brm\b/.test(cmd))                     return "DELETE";
    return "EXEC";
}

// ---------------------------------------------------------------------------
// formatResult — Option 1: log the command result
// ---------------------------------------------------------------------------
// Produces a compact one-line summary of what came back from the executor so
// the agent container log shows the feedback loop (cmd → result).
// ---------------------------------------------------------------------------

function formatResult(result: string): string {
    const MAX = 300;
    const trimmed = result.trim();
    if (!trimmed || trimmed === "(no output)") return "(no output)";
    // Truncate to MAX chars; show first line of actual output
    const firstLines = trimmed.split("\n").slice(0, 4).join(" ↵ ");
    return firstLines.length > MAX ? firstLines.slice(0, MAX) + "…" : firstLines;
}

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

            const action = classifyAction(command);

            if (EXECUTOR_URL) {
                // ── Sandboxed path: route through executor sidecar ──────────
                // Option 2: semantic label  Option 1: echo result
                console.log(`[deepagent:bash] [${action}] → ${command.slice(0, 200)}`);
                const result = await runViaExecutor(command, cwd, effectiveTimeout);
                console.log(`[deepagent:bash] [${action}] ← ${formatResult(result)}`);
                return result;
            } else {
                // ── Local dev path: run directly (no Docker) ───────────────
                console.log(`[deepagent:bash] [${action}] local: ${command.slice(0, 200)}`);
                const result = await runLocally(command, cwd, effectiveTimeout);
                console.log(`[deepagent:bash] [${action}] ← ${formatResult(result)}`);
                return result;
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
