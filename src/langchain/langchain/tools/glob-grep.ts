import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";

const GlobInputSchema = z.object({
    pattern: z
        .string()
        .describe(
            "Glob pattern to match, e.g. '**/*.ts', 'src/**/*.test.ts'. " +
            "Always relative to the workspace root."
        ),
    ignore: z
        .array(z.string())
        .optional()
        .default(["**/node_modules/**", "**/.git/**", "**/dist/**"])
        .describe("Glob patterns to exclude (default: node_modules, .git, dist)"),
});

const GrepInputSchema = z.object({
    pattern: z.string().describe("String or regex pattern to search for"),
    path: z
        .string()
        .optional()
        .default(".")
        .describe("Directory or file path to search in (relative to workspace root)"),
    include: z
        .string()
        .optional()
        .describe("File glob to restrict search, e.g. '*.ts'"),
    case_insensitive: z.boolean().optional().default(false),
    max_results: z.number().int().positive().optional().default(50),
});

/**
 * Minimal async glob using node:fs — no extra dependencies.
 * For large repos, consider switching to the `fast-glob` package.
 */
async function walkGlob(
    dir: string,
    pattern: RegExp,
    ignore: RegExp[],
    results: string[],
    root: string
): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return;
    }

    for (const name of names) {
        const full = path.join(dir, name);
        const rel  = path.relative(root, full).replace(/\\/g, "/");

        if (ignore.some((ig) => ig.test(rel))) continue;

        let stat: Awaited<ReturnType<typeof fs.stat>>;
        try {
            stat = await fs.stat(full);
        } catch {
            continue;
        }

        if (stat.isDirectory()) {
            await walkGlob(full, pattern, ignore, results, root);
        } else if (pattern.test(rel)) {
            results.push(rel);
        }
    }
}

/** Convert a glob pattern to a RegExp (handles **, *, ?, character classes). */
function globToRegExp(glob: string): RegExp {
    const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials (except * and ?)
        .replace(/\*\*/g, "§§DOUBLESTAR§§")
        .replace(/\*/g, "[^/]*")
        .replace(/§§DOUBLESTAR§§/g, ".*")
        .replace(/\?/g, "[^/]");
    return new RegExp(`^${escaped}$`);
}

export function makeGlobTool(cwd: string) {
    return tool(
        async ({ pattern, ignore }) => {
            const patternRe = globToRegExp(pattern);
            const ignoreRes = ignore.map(globToRegExp);

            const results: string[] = [];
            await walkGlob(cwd, patternRe, ignoreRes, results, cwd);

            if (results.length === 0) return "No files matched.";
            console.log(`[glob] Pattern="${pattern}" → ${results.length} files`);
            return results.join("\n");
        },
        {
            name: "glob",
            description:
                "Find files in the workspace matching a glob pattern. " +
                "Returns newline-separated relative paths. " +
                "node_modules, .git, and dist are excluded by default.",
            schema: GlobInputSchema,
        }
    );
}

export function makeGrepTool(cwd: string) {
    return tool(
        async ({ pattern, path: searchPath, include, case_insensitive, max_results }) => {
            const targetDir = path.resolve(cwd, searchPath ?? ".");

            if (!targetDir.startsWith(cwd)) {
                return `ERROR: Access denied — path is outside the workspace`;
            }

            const flags = case_insensitive ? "gi" : "g";
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, flags);
            } catch {
                return `ERROR: Invalid regex pattern: ${pattern}`;
            }

            const includeRe = include ? globToRegExp(include) : null;
            const ignoreRes = [
                globToRegExp("**/node_modules/**"),
                globToRegExp("**/.git/**"),
                globToRegExp("**/dist/**"),
            ];

            // Collect all candidate files
            const allFiles: string[] = [];
            await walkGlob(targetDir, /.*/, ignoreRes, allFiles, cwd);

            const matches: string[] = [];

            for (const relFile of allFiles) {
                if (matches.length >= max_results) break;
                if (includeRe && !includeRe.test(path.basename(relFile))) continue;

                const abs = path.resolve(cwd, relFile);
                let content: string;
                try {
                    content = await fs.readFile(abs, "utf8");
                } catch {
                    continue; // skip unreadable files
                }

                const lines = content.split("\n");
                for (let i = 0; i < lines.length && matches.length < max_results; i++) {
                    const line = lines[i] ?? "";
                    if (regex.test(line)) {
                        matches.push(`${relFile}:${i + 1}: ${line.trimEnd()}`);
                    }
                }
            }

            if (matches.length === 0) return "No matches found.";
            console.log(`[grep] Pattern="${pattern}" → ${matches.length} matches`);
            return matches.join("\n");
        },
        {
            name: "grep",
            description:
                "Search for a string or regex pattern across files in the workspace. " +
                "Returns matching lines in the format: 'file:line: content'. " +
                "Use include to restrict to a file type, e.g. '*.ts'.",
            schema: GrepInputSchema,
        }
    );
}
