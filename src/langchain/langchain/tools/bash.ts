import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const BashInputSchema = z.object({
    command: z.string().describe("The bash command to execute"),
    timeout: z
        .number()
        .optional()
        .default(30_000)
        .describe("Timeout in milliseconds (default 30s)"),
});

/**
 * Creates a Bash tool scoped to a specific working directory.
 * The cwd is bound at construction time so the agent cannot escape the workspace.
 */
export function makeBashTool(cwd: string, guard: (cmd: string) => { blocked: true; reason: string } | { blocked: false }) {
    return tool(
        async ({ command, timeout }) => {
            const check = guard(command);
            if (check.blocked) {
                console.warn(`[bash] Blocked: ${command.slice(0, 120)}\n  Reason: ${check.reason}`);
                return `BLOCKED: ${check.reason}`;
            }

            console.log(`[bash] Executing: ${command.slice(0, 200)}`);
            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd,
                    timeout,
                    maxBuffer: 10 * 1024 * 1024, // 10 MB
                });
                const out = [stdout, stderr].filter(Boolean).join("\n---stderr---\n");
                return out || "(no output)";
            } catch (err: unknown) {
                const e = err as { message?: string; stdout?: string; stderr?: string };
                return `ERROR: ${e.message ?? String(err)}\n${e.stderr ?? ""}`.trim();
            }
        },
        {
            name: "bash",
            description:
                "Run a bash shell command inside the workspace directory. Use for git, npm, running tests, etc. " +
                "Dangerous commands (sudo, force-push, rm -rf /, curl|sh, etc.) are blocked.",
            schema: BashInputSchema,
        }
    );
}
