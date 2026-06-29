import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const WriteFileInputSchema = z.object({
    file_path: z.string().describe("Absolute or workspace-relative path to write to"),
    content: z.string().describe("Full content to write to the file"),
    create_dirs: z
        .boolean()
        .optional()
        .default(true)
        .describe("Automatically create parent directories if they don't exist (default true)"),
});

const EditFileInputSchema = z.object({
    file_path: z.string().describe("Absolute or workspace-relative path to the file to edit"),
    old_string: z
        .string()
        .describe("Exact string to find and replace — must be unique in the file"),
    new_string: z.string().describe("Replacement string"),
});

/**
 * Writes (creates or fully overwrites) a file inside the workspace.
 */
export function makeWriteFileTool(cwd: string) {
    return tool(
        async ({ file_path, content, create_dirs }) => {
            const resolved = path.isAbsolute(file_path)
                ? file_path
                : path.resolve(cwd, file_path);

            if (!resolved.startsWith(cwd)) {
                return `ERROR: Access denied — path is outside the workspace (${resolved})`;
            }

            if (create_dirs) {
                await fs.mkdir(path.dirname(resolved), { recursive: true });
            }

            await fs.writeFile(resolved, content, "utf8");
            console.log(`[write-file] Written ${content.length} chars → ${resolved}`);
            return `OK: wrote ${content.length} characters to ${resolved}`;
        },
        {
            name: "write_file",
            description:
                "Create or fully overwrite a file in the workspace with the supplied content. " +
                "For surgical edits to existing files, prefer edit_file instead.",
            schema: WriteFileInputSchema,
        }
    );
}

/**
 * Performs a targeted find-and-replace within an existing file.
 * Fails fast if old_string is not found or appears more than once.
 */
export function makeEditFileTool(cwd: string) {
    return tool(
        async ({ file_path, old_string, new_string }) => {
            const resolved = path.isAbsolute(file_path)
                ? file_path
                : path.resolve(cwd, file_path);

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

            const occurrences = content.split(old_string).length - 1;
            if (occurrences === 0) {
                return `ERROR: old_string not found in ${resolved}. No changes made.`;
            }
            if (occurrences > 1) {
                return (
                    `ERROR: old_string found ${occurrences} times in ${resolved} — ` +
                    `provide more context to make it unique. No changes made.`
                );
            }

            const updated = content.replace(old_string, new_string);
            await fs.writeFile(resolved, updated, "utf8");
            console.log(`[edit-file] Patched ${resolved}`);
            return `OK: replaced 1 occurrence in ${resolved}`;
        },
        {
            name: "edit_file",
            description:
                "Surgically replace an exact string (old_string) with new_string in an existing file. " +
                "old_string must appear exactly once — add more surrounding context if it is ambiguous.",
            schema: EditFileInputSchema,
        }
    );
}
