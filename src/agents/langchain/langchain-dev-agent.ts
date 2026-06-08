/**
 * LangChainDevAgent
 *
 * A full dev agent built with LangChain.js + LangGraph that mirrors
 * the behaviour of the SDK-based DevAgent:
 *
 *  - Same model (claude-haiku-4-5)
 *  - Same tool set: Read, Write, Edit, Glob, Grep, Bash
 *  - Same safety guardrails (bash blocklist)
 *  - Same cost/turn limits
 *  - Same REVIEW.json parsing for the verdict
 *  - Implements the Agent interface so the orchestrator can swap
 *    implementations via AGENT_TYPE env-var
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { Agent, JobResult, ReviewVerdict } from "../types.js";
import type { JiraStory, Workspace } from "../../workspace-manager/types.js";
import { createFsTools } from "./tools/fs-tools.js";
import { createBashTool } from "./tools/bash-tool.js";

const MAX_BUDGET_USD = Number(process.env.MAX_BUDGET_USD ?? "3.00");
const MAX_TURNS = Number(process.env.MAX_TURNS ?? "60");

/** Approximate cost per token for claude-haiku-4-5 (USD). */
const COST_PER_INPUT_TOKEN = 0.80 / 1_000_000;   // $0.80 / M input tokens
const COST_PER_OUTPUT_TOKEN = 4.00 / 1_000_000;  // $4.00 / M output tokens

export class LangChainDevAgent implements Agent {
    private readonly maxBudgetUsd: number;
    private readonly maxTurns: number;

    constructor(maxBudgetUsd = MAX_BUDGET_USD, maxTurns = MAX_TURNS) {
        this.maxBudgetUsd = maxBudgetUsd || 0.5;
        this.maxTurns = maxTurns;
    }

    async run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult> {
        const { jobId, jobDir } = workspace;
        console.log(`[lc-agent] [${jobId}] Starting — story=${story.id} cwd=${jobDir}`);
        console.log(`[lc-agent] [${jobId}] Limits — maxBudget=$${this.maxBudgetUsd} maxTurns=${this.maxTurns}`);

        // ── Model ────────────────────────────────────────────────────────────
        const model = new ChatAnthropic({
            model: "claude-haiku-4-5",
            // Let the platform's own maxTurns / budget guard handle stopping;
            // we don't set maxTokens here — the per-message output is fine unbounded.
        });

        // ── Tools ────────────────────────────────────────────────────────────
        const { readFileTool, writeFileTool, editFileTool, globTool, grepTool } =
            createFsTools(jobDir);
        const bashTool = createBashTool(jobDir);

        const tools = [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool];

        // ── Agent graph ──────────────────────────────────────────────────────
        const agentExecutor = createReactAgent({
            llm: model,
            tools,
        });

        // ── System prompt (operational guidelines from CLAUDE.md) ────────────
        const systemPrompt = story.claudeMd;

        // ── Run ──────────────────────────────────────────────────────────────
        const messages: string[] = [];
        let turnCount = 0;
        let inputTokens = 0;
        let outputTokens = 0;

        console.log(`[lc-agent] [${jobId}] Sending prompt to Claude via LangChain...`);

        const userPrompt = this.buildPrompt(story);

        try {
            const stream = agentExecutor.streamEvents(
                {
                    messages: [
                        new SystemMessage(systemPrompt),
                        new HumanMessage(userPrompt),
                    ],
                },
                {
                    version: "v2",
                    signal: signal,
                }
            );

            for await (const event of stream) {
                // Abort if signal fired
                if (signal?.aborted) {
                    console.warn(`[lc-agent] [${jobId}] Abort signal received — stopping stream.`);
                    break;
                }

                // Count LLM turns and accumulate token usage
                if (event.event === "on_chat_model_end") {
                    turnCount++;
                    console.log(`[lc-agent] [${jobId}] Turn ${turnCount} — LLM response received`);

                    const output = event.data?.output;

                    // Collect text from the response
                    const responseText: string =
                        typeof output?.content === "string"
                            ? output.content
                            : Array.isArray(output?.content)
                              ? output.content
                                    .filter((b: { type: string }) => b.type === "text")
                                    .map((b: { text: string }) => b.text)
                                    .join("")
                              : "";

                    if (responseText) {
                        messages.push(responseText);
                        console.log(`[lc-agent] [${jobId}] Text:\n${responseText}`);
                    }

                    // Accumulate token usage
                    const usage = output?.usage_metadata;
                    if (usage) {
                        inputTokens += usage.input_tokens ?? 0;
                        outputTokens += usage.output_tokens ?? 0;
                    }

                    // Enforce turn limit
                    if (turnCount >= this.maxTurns) {
                        console.warn(`[lc-agent] [${jobId}] Hit max turns (${this.maxTurns}) — stopping.`);
                        break;
                    }

                    // Enforce budget limit
                    const costSoFar =
                        inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
                    if (costSoFar >= this.maxBudgetUsd) {
                        console.warn(
                            `[lc-agent] [${jobId}] Budget cap reached ($${costSoFar.toFixed(4)}) — stopping.`
                        );
                        break;
                    }
                }

                // Log tool calls
                if (event.event === "on_tool_start") {
                    console.log(
                        `[lc-agent] [${jobId}] Tool call: ${event.name} — input: ${JSON.stringify(event.data?.input, null, 2)}`
                    );
                    if (event.name === "Read") {
                        const inputData = event.data?.input as { file_path?: string } | undefined;
                        if (inputData?.file_path?.endsWith("CLAUDE.md")) {
                            console.log(
                                `[lc-agent] [${jobId}] ✅ CLAUDE.md read confirmed — agent has received operational guidelines`
                            );
                        }
                    }
                }
            }
        } catch (err: unknown) {
            if (signal?.aborted) {
                console.warn(`[lc-agent] [${jobId}] Stream ended due to abort signal.`);
            } else {
                throw err;
            }
        }

        const costUsd = inputTokens * COST_PER_INPUT_TOKEN + outputTokens * COST_PER_OUTPUT_TOKEN;
        const turns = turnCount;

        console.log(
            `[lc-agent] Job ${jobId} complete. Turns: ${turns}, Cost: $${costUsd.toFixed(4)}`
        );

        // ── Parse verdict ────────────────────────────────────────────────────
        console.log(`[lc-agent] [${jobId}] Parsing verdict from REVIEW.json...`);
        const verdict = await this.parseVerdict(jobDir, messages);
        console.log(
            `[lc-agent] [${jobId}] Verdict: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ""}`
        );

        return {
            storyId: story.id,
            verdict: verdict.verdict,
            ...(verdict.reason !== undefined && { reason: verdict.reason }),
            costUsd,
            turns,
        };
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    /**
     * The agent is instructed to write REVIEW.json before exiting.
     * We read it from the workspace; fall back to text parsing if absent.
     */
    private async parseVerdict(jobDir: string, messages: string[]): Promise<ReviewVerdict> {
        const fs = await import("fs/promises");
        const path = await import("path");

        const reviewPath = path.join(jobDir, "REVIEW.json");
        try {
            const raw = await fs.readFile(reviewPath, "utf8");
            const json = JSON.parse(raw) as ReviewVerdict;
            console.log(`[lc-agent] REVIEW.json read successfully from ${reviewPath}`);
            return json;
        } catch {
            console.warn(
                `[lc-agent] REVIEW.json not found at ${reviewPath} — inferring verdict from message text`
            );
            const combined = messages.join("\n").toLowerCase();
            if (combined.includes("pass")) return { verdict: "PASS", reason: "inferred from output" };
            if (combined.includes("partial")) return { verdict: "PARTIAL", reason: "inferred from output" };
            console.error(`[lc-agent] Could not infer verdict — defaulting to FAIL`);
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
