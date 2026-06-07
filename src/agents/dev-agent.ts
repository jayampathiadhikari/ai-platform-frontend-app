import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, JobResult, ReviewVerdict } from "./types.ts";
import type { JiraStory, Workspace } from "../workspace-manager/types.js";

const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD ?? "3.00");
const MAX_TURNS = Number(process.env.MAX_TURNS ?? "60");


export class DevAgent implements Agent {
    private readonly maxBudgetUsd: number;
    private readonly maxTurns: number;

    constructor(maxBudgetUsd = MAX_BUDGET_USD, maxTurns = MAX_TURNS) {
        this.maxBudgetUsd = maxBudgetUsd || 2;
        this.maxTurns = maxTurns;
    }

    async run(story: JiraStory, workspace: Workspace): Promise<JobResult> {
        console.log(`[agent] Starting job ${workspace.jobId}`);

        const options: Options = {
            // Working directory locked to this job's isolated worktree
            cwd: workspace.jobDir,

            // No resume — always a fresh session per job.
            // If story.checkpointRef is set, the caller restores files from S3
            // before we get here; the session itself always starts clean.
            persistSession: false, // session lives in-memory only, nothing written to disk

            // Hard cost cap — runaway loop protection
            maxBudgetUsd: this.maxBudgetUsd,
            maxTurns: this.maxTurns,

            // Tools scoped to what a dev agent actually needs
            allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        };

        let resultMessage: SDKResultMessage | undefined;
        const messages: string[] = [];

        for await (const message of query({
            prompt: this.buildPrompt(story),
            options,
        })) {
            if (message.type === "assistant") {
                // Collect text output for verdict parsing
                for (const block of message.message.content) {
                    if (block.type === "text") {
                        messages.push(block.text);
                    }
                }
            }

            if (message.type === "result") {
                resultMessage = message;

                if (message.subtype === "error_max_turns") {
                    console.warn(`[agent] Hit max turns for ${workspace.jobId}`);
                }
                if (message.subtype === "error_max_budget_usd") {
                    console.warn(`[agent] Budget exceeded for ${workspace.jobId}`);
                }
            }
        }

        const costUsd = resultMessage?.total_cost_usd ?? 0;
        const turns = resultMessage?.num_turns ?? 0;

        console.log(
            `[agent] Job ${workspace.jobId} complete. Turns: ${turns}, Cost: $${costUsd.toFixed(4)}`
        );

        // Parse the REVIEW.json verdict the agent is instructed to write
        const verdict = await this.parseVerdict(workspace.jobDir, messages);

        return {
            storyId: story.id,
            verdict: verdict.verdict,
            ...(verdict.reason !== undefined && { reason: verdict.reason }),
            costUsd,
            turns,
        };
    }

    /**
     * The agent is instructed to write REVIEW.json before exiting.
     * We read it from the workspace; fall back to text parsing if absent.
     */
    private async parseVerdict(
        jobDir: string,
        messages: string[]
    ): Promise<ReviewVerdict> {
        const fs = await import("fs/promises");
        const path = await import("path");

        try {
            const raw = await fs.readFile(path.join(jobDir, "REVIEW.json"), "utf8");
            const json = JSON.parse(raw) as ReviewVerdict;
            return json;
        } catch {
            // REVIEW.json not written — infer from message content
            const combined = messages.join("\n").toLowerCase();
            if (combined.includes("pass")) return { verdict: "PASS", reason: "inferred from output" };
            if (combined.includes("partial")) return { verdict: "PARTIAL", reason: "inferred from output" };
            return { verdict: "FAIL", reason: "REVIEW.json not found" };
        }
    }

    private buildPrompt(story: JiraStory): string {
        return `
You are implementing Jira story ${story.id}.

The full task specification is in TASK.md and your operational guidelines are in CLAUDE.md.
Both files are in your current working directory.

When you are done:
1. Commit your changes on the current branch
2. Push the branch to origin
3. Write a REVIEW.json file in the workspace root with this shape:
   { "verdict": "PASS" | "FAIL" | "PARTIAL", "reason": "..." }

Do NOT open the pull request yourself — the platform will do that automatically.

Begin by reading TASK.md.
`.trim();
    }
}