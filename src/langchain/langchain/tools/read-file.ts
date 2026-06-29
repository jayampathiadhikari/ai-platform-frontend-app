import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const ReadFileInputSchema = z.object({
    file_path: z.string().describe("Absolute or workspace-relative path to the file to read"),
    start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-indexed line to start reading from (inclusive)"),
    end_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-indexed line to stop reading at (inclusive)"),
});

/**
 * Read a file from the workspace, optionally sliced to a line range.
 * Path is resolved relative to cwd so the agent never escapes the workspace.
 */
export function makeReadFileTool(cwd: string) {
    return tool(
        async ({ file_path, start_line, end_line }) => {
            const resolved = path.isAbsolute(file_path)
                ? file_path
                : path.resolve(cwd, file_path);

            // Prevent path traversal outside the workspace
            if (!resolved.startsWith(cwd)) {
                return `ERROR: Access denied — path is outside the workspace (${resolved})`;
            }

            let content: string;
            try {
                content = await fs.readFile(resolved, "utf8");
            } catch (err: unknown) {
                const e = err as { code?: string; message?: string };
                if (e.code === "ENOENT") return `ERROR: File not found: ${resolved}`;
                return `ERROR: ${e.message ?? String(err)}`;
            }

            const lines = content.split("\n");
            const start = (start_line ?? 1) - 1;          // 0-indexed
            const end   = end_line ?? lines.length;        // inclusive → slice end

            const sliced = lines.slice(start, end).join("\n");
            console.log(`[read-file] ${resolved} lines ${start + 1}–${end} (${sliced.length} chars)`);
            return sliced;
        },
        {
            name: "read_file",
            description:
                "Read the content of a file in the workspace. " +
                "Provide start_line / end_line to read a specific range (1-indexed, inclusive).",
            schema: ReadFileInputSchema,
        }
    );
}
