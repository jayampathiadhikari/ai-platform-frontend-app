/**
 * LangChain file-system tools scoped to the job's isolated worktree.
 *
 * Tools exposed:
 *   readFileTool  — Read a file (mirrors SDK "Read")
 *   writeFileTool — Write / overwrite a file (mirrors SDK "Write")
 *   editFileTool  — Replace an exact string within a file (mirrors SDK "Edit")
 *   globTool      — Glob for files under cwd (mirrors SDK "Glob")
 *   grepTool      — Grep for a pattern in files (mirrors SDK "Grep")
 *
 * All paths are resolved relative to the provided `cwd` and any attempt to
 * escape the worktree via path traversal is rejected.
 */

import fs from "fs/promises";
import path from "path";
import { glob as fastGlob } from "fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve `filePath` relative to `cwd` and verify it stays inside `cwd`.
 * Throws if the resolved path escapes the worktree.
 */
function safePath(cwd: string, filePath: string): string {
    const resolved = path.resolve(cwd, filePath);
    if (!resolved.startsWith(path.resolve(cwd) + path.sep) && resolved !== path.resolve(cwd)) {
        throw new Error(`Path traversal rejected: "${filePath}" escapes the workspace root.`);
    }
    return resolved;
}

// ─── factory ────────────────────────────────────────────────────────────────

/**
 * Returns all five FS tools scoped to the given working directory.
 */
export function createFsTools(cwd: string) {
    // ── Read ──────────────────────────────────────────────────────────────
    const readFileTool = tool(
        async ({ file_path }: { file_path: string }) => {
            const abs = safePath(cwd, file_path);
            try {
                return await fs.readFile(abs, "utf8");
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error reading file: ${msg}`;
            }
        },
        {
            name: "Read",
            description: "Read the contents of a file in the workspace.",
            schema: z.object({
                file_path: z.string().describe("Path to the file, relative to the workspace root."),
            }),
        }
    );

    // ── Write ─────────────────────────────────────────────────────────────
    const writeFileTool = tool(
        async ({ file_path, content }: { file_path: string; content: string }) => {
            const abs = safePath(cwd, file_path);
            try {
                await fs.mkdir(path.dirname(abs), { recursive: true });
                await fs.writeFile(abs, content, "utf8");
                return `File written: ${file_path}`;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error writing file: ${msg}`;
            }
        },
        {
            name: "Write",
            description: "Write (create or overwrite) a file in the workspace.",
            schema: z.object({
                file_path: z.string().describe("Path to the file, relative to the workspace root."),
                content: z.string().describe("Full content to write to the file."),
            }),
        }
    );

    // ── Edit ──────────────────────────────────────────────────────────────
    const editFileTool = tool(
        async ({
            file_path,
            old_string,
            new_string,
        }: {
            file_path: string;
            old_string: string;
            new_string: string;
        }) => {
            const abs = safePath(cwd, file_path);
            try {
                const original = await fs.readFile(abs, "utf8");
                if (!original.includes(old_string)) {
                    return `Error: old_string not found in ${file_path}. No changes made.`;
                }
                const updated = original.replace(old_string, new_string);
                await fs.writeFile(abs, updated, "utf8");
                return `File edited: ${file_path}`;
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error editing file: ${msg}`;
            }
        },
        {
            name: "Edit",
            description:
                "Replace an exact string in a file. The old_string must match exactly (including whitespace). " +
                "Only the first occurrence is replaced.",
            schema: z.object({
                file_path: z.string().describe("Path to the file, relative to the workspace root."),
                old_string: z.string().describe("Exact string to search for."),
                new_string: z.string().describe("Replacement string."),
            }),
        }
    );

    // ── Glob ──────────────────────────────────────────────────────────────
    const globTool = tool(
        async ({ pattern }: { pattern: string }) => {
            try {
                const results: string[] = [];
                for await (const entry of fastGlob(pattern, { cwd })) {
                    results.push(String(entry));
                }
                return results.length > 0
                    ? results.join("\n")
                    : "No files matched the pattern.";
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                return `Error running glob: ${msg}`;
            }
        },
        {
            name: "Glob",
            description: "Find files in the workspace matching a glob pattern.",
            schema: z.object({
                pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'."),
            }),
        }
    );

    // ── Grep ──────────────────────────────────────────────────────────────
    const grepTool = tool(
        async ({ pattern, path: searchPath }: { pattern: string; path?: string }) => {
            const { execFile } = await import("child_process");
            const { promisify } = await import("util");
            const execFileAsync = promisify(execFile);

            const target = searchPath ? safePath(cwd, searchPath) : cwd;
            try {
                const { stdout } = await execFileAsync(
                    "grep",
                    ["-rn", "--include=*", pattern, target],
                    { cwd }
                );
                return stdout.trim() || "No matches found.";
            } catch (err: unknown) {
                // grep exits 1 when no matches — that's not a real error
                if ((err as NodeJS.ErrnoException).code === 1) return "No matches found.";
                const msg = err instanceof Error ? err.message : String(err);
                return `Error running grep: ${msg}`;
            }
        },
        {
            name: "Grep",
            description: "Search for a regex pattern in files within the workspace.",
            schema: z.object({
                pattern: z.string().describe("Regular expression to search for."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional subdirectory or file to restrict the search to."),
            }),
        }
    );

    return { readFileTool, writeFileTool, editFileTool, globTool, grepTool };
}
