// =============================================================================
// Executor Sidecar — HTTP server
// =============================================================================
// Tiny Node.js HTTP server that executes shell commands on behalf of the agent.
//
// Security properties:
//   - No AWS credentials / env vars (ECS task def excludes them)
//   - No AWS CLI installed
//   - Runs with a non-root user (node)
//   - Commands are executed with cwd clamped to WORKSPACE_ROOT
//   - Only reachable on localhost (127.0.0.1:8080) — not externally exposed
//
// API:
//   POST /exec   { command: string, cwd?: string, timeout?: number }
//             → { stdout: string, stderr: string, exitCode: number }
//   GET  /health → 200 OK
// =============================================================================

import { createServer, IncomingMessage } from "node:http";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, normalize } from "node:path";

const execAsync = promisify(exec);

const PORT = Number(process.env.EXECUTOR_PORT ?? "8080");
const HOST = process.env.EXECUTOR_HOST ?? "0.0.0.0";
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace/jobs";
const MAX_TIMEOUT_MS = 120_000; // hard cap: 2 minutes
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB output cap

// Monotonic counter for correlating log lines per request
let requestCounter = 0;
function nextReqId(): string { return `req-${++requestCounter}`; }

// ---------------------------------------------------------------------------
// Clamp the requested cwd to within WORKSPACE_ROOT.
// If the resolved path escapes the root, fall back to WORKSPACE_ROOT itself.
// ---------------------------------------------------------------------------
function safeCwd(requested?: string): string {
    if (!requested) return WORKSPACE_ROOT;
    const resolved = resolve(WORKSPACE_ROOT, requested);
    const normalized = normalize(resolved);
    // Must start with WORKSPACE_ROOT to be safe
    if (!normalized.startsWith(normalize(WORKSPACE_ROOT))) {
        console.warn(`[executor] cwd escape attempt: ${requested} → clamped to ${WORKSPACE_ROOT}`);
        return WORKSPACE_ROOT;
    }
    return normalized;
}

// ---------------------------------------------------------------------------
// Preprocess the command string to rewrite absolute paths (starting with /)
// to be relative to the job workspace CWD, unless they are system paths.
// This supports the agent's expectation of operating inside a root "/" workspace.
// ---------------------------------------------------------------------------
function rewriteCommandPaths(command: string, cwd: string): string {
    const pathRegex = /(?<=^|[\s&|;(){}[\]'"`<>])\/(?:[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\/?)?/g;
    const systemPrefixes = [
        "/dev", "/proc", "/sys", "/tmp", "/bin", "/usr", "/etc", "/var", "/lib", "/opt", "/app", "/workspace"
    ];

    return command.replace(pathRegex, (matchedPath) => {
        if (matchedPath === "/") {
            return cwd;
        }

        const isSystem = systemPrefixes.some(prefix => 
            matchedPath === prefix || matchedPath.startsWith(prefix + "/")
        );

        if (isSystem) {
            return matchedPath;
        }

        const suffix = matchedPath.startsWith("/") ? matchedPath.slice(1) : matchedPath;
        return cwd.endsWith("/") ? `${cwd}${suffix}` : `${cwd}/${suffix}`;
    });
}

// ---------------------------------------------------------------------------
// Read the full request body as a string
// ---------------------------------------------------------------------------
function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
    const rid = nextReqId();
    const start = Date.now();

    // Health check
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
    }

    // Command execution
    if (req.method === "POST" && req.url === "/exec") {
        console.info(`[executor] [${rid}] → ${req.method} ${req.url}`);
        let body: { command?: unknown; cwd?: unknown; timeout?: unknown };
        try {
            const raw = await readBody(req);
            console.info(`[executor] [${rid}] body received (${raw.length} bytes)`);
            body = JSON.parse(raw) as typeof body;
        } catch (parseErr) {
            console.warn(`[executor] [${rid}] body parse error: ${String(parseErr)}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON body" }));
            return;
        }

        const command = typeof body.command === "string" ? body.command : null;
        if (!command) {
            console.warn(`[executor] [${rid}] rejected: missing or non-string 'command' field`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "command is required and must be a string" }));
            return;
        }

        const cwd = safeCwd(typeof body.cwd === "string" ? body.cwd : undefined);
        const timeout = Math.min(
            typeof body.timeout === "number" ? body.timeout : 30_000,
            MAX_TIMEOUT_MS
        );
        const effectiveCommand = rewriteCommandPaths(command, cwd);

        console.info(
            `[executor] [${rid}] exec start` +
            ` | cmd: ${command.slice(0, 150)}${command.length > 150 ? "…" : ""}` +
            ` | rewritten: ${effectiveCommand.slice(0, 150)}${effectiveCommand.length > 150 ? "…" : ""}` +
            ` | cwd: ${cwd}` +
            ` | timeout: ${timeout}ms`
        );

        try {
            const { stdout, stderr } = await execAsync(effectiveCommand, {
                cwd,
                timeout,
                maxBuffer: MAX_BUFFER,
                // Explicitly clear any inherited AWS credential vars — belt-and-suspenders
                env: {
                    ...process.env,
                    AWS_ACCESS_KEY_ID: undefined,
                    AWS_SECRET_ACCESS_KEY: undefined,
                    AWS_SESSION_TOKEN: undefined,
                    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
                    AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
                    // Keep PATH so node/npm/git are still available
                    PATH: process.env["PATH"],
                    HOME: "/tmp",
                },
            });

            const elapsed = Date.now() - start;
            console.info(
                `[executor] [${rid}] exec success` +
                ` | exit: 0` +
                ` | stdout: ${stdout.length}B` +
                ` | stderr: ${stderr.length}B` +
                ` | elapsed: ${elapsed}ms`
            );

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ stdout, stderr, exitCode: 0 }));
        } catch (err: unknown) {
            const e = err as {
                message?: string;
                stdout?: string;
                stderr?: string;
                code?: number;
                killed?: boolean;
            };
            const exitCode = typeof e.code === "number" ? e.code : 1;
            const elapsed = Date.now() - start;

            if (e.killed) {
                console.warn(
                    `[executor] [${rid}] exec TIMEOUT` +
                    ` | timeout: ${timeout}ms` +
                    ` | elapsed: ${elapsed}ms`
                );
            } else {
                console.error(
                    `[executor] [${rid}] exec failed` +
                    ` | exit: ${exitCode}` +
                    ` | elapsed: ${elapsed}ms` +
                    ` | message: ${e.message ?? String(err)}`
                );
            }

            res.writeHead(200, { "Content-Type": "application/json" }); // 200 even on non-zero exit
            res.end(JSON.stringify({
                stdout: e.stdout ?? "",
                stderr: e.stderr ?? (e.killed ? "TIMEOUT" : e.message ?? String(err)),
                exitCode,
            }));
        }
        return;
    }

    // Unknown route
    console.warn(`[executor] [${rid}] 404 unknown route: ${req.method} ${req.url}`);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, HOST, () => {
    console.info(`[executor] ┌─ Executor sidecar started ───────────────────────`);
    console.info(`[executor] │  listening:      ${HOST}:${PORT}`);
    console.info(`[executor] │  WORKSPACE_ROOT: ${WORKSPACE_ROOT}`);
    console.info(`[executor] │  MAX_TIMEOUT_MS: ${MAX_TIMEOUT_MS}ms`);
    console.info(`[executor] │  MAX_BUFFER:     ${MAX_BUFFER / 1024 / 1024}MB`);
    console.info(`[executor] └────────────────────────────────────────────────`);
});
