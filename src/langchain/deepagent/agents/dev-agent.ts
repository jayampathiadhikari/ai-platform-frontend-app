import { createDeepAgent, FilesystemBackend } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";

import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";
import type { Agent, JobResult } from "../../types.js";
import { makeBashTool } from "./helpers/bash-runner.js";
import { extractFinalText, parseVerdict } from "./helpers/message-utils.js";
import { SYSTEM_PROMPT } from "./constants.js";

const ANTHROPIC_MODEL  = process.env.ANTHROPIC_MODEL  ?? "claude-haiku-4-5";
const MAX_ITERATIONS   = Number(process.env.MAX_TURNS ?? "60");

// ---------------------------------------------------------------------------
// DeepDevAgent — uses the official `deepagents` `createDeepAgent` harness
// ---------------------------------------------------------------------------

/**
 * A developer agent built on the official LangChain Deep Agents SDK
 * (`npm install deepagents`). It uses `createDeepAgent` which ships with:
 *
 *   - Built-in virtual filesystem tools (read_file, write_file, edit_file, glob, grep, ls)
 *   - write_todos task-planning tool
 *   - Automatic context summarization to handle long-running tasks
 *   - Subagent delegation via the built-in `task` tool
 *   - Prompt caching (Anthropic models)
 *
 * The agent also receives a workspace-scoped `bash` tool for git/shell operations.
 */
export class DeepDevAgent implements Agent {
    private readonly model: string;
    private readonly maxIterations: number;

    constructor(model = ANTHROPIC_MODEL, maxIterations = MAX_ITERATIONS) {
        this.model         = model;
        this.maxIterations = maxIterations;
    }

    async run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult> {
        const { jobId, jobDir } = workspace;

        console.log(`[deepagent] [${jobId}] Starting — story=${story.id} cwd=${jobDir}`);
        console.log(`[deepagent] [${jobId}] Model=${this.model} maxIterations=${this.maxIterations}`);

        // ── Build the model ─────────────────────────────────────────────────
        const llm = new ChatAnthropic({
            model:       this.model,
            temperature: 0,
            maxTokens:   8192,
            ...(signal ? { signal } : {}),
        });

        // ── Build workspace-scoped bash tool ─────────────────────────────────
        const bashTool = makeBashTool(jobDir);

        // ── Create the Deep Agent ────────────────────────────────────────────
        //
        // `createDeepAgent` assembles a production-ready agent harness with:
        //   • Virtual filesystem backed by agent state (StateBackend)
        //   • write_todos planning tool
        //   • Automatic summarization for long runs
        //   • Built-in `task` tool for subagent delegation
        //   • Prompt caching for Anthropic models
        //
        const agent = createDeepAgent({
            model:        llm,
            systemPrompt: SYSTEM_PROMPT,
            tools:        [bashTool],
            backend:      new FilesystemBackend({ rootDir: jobDir, virtualMode: true }),
            // Restrict filesystem write access to the job workspace only
            permissions: [
                { operations: ["read", "write"], paths: ["/**"], mode: "allow" },
            ],
        });

        // ── Build initial messages ───────────────────────────────────────────
        // NOTE: We deliberately do NOT expose the real host path (jobDir) here.
        // The agent operates entirely within the virtual filesystem rooted at "/",
        // so it should only ever reference virtual paths like /TASK.md, /src/, etc.
        const userPrompt = `\
You are implementing Jira story ${story.id}.

The full task specification is in /TASK.md and your operational guidelines are in /CLAUDE.md.
Both files are at the root of your virtual workspace ("/").

Begin by using write_todos to plan your work, then implement the story step by step.`;

        // ── Invoke the agent ─────────────────────────────────────────────────
        console.log(`[deepagent] [${jobId}] Invoking Deep Agent...`);

        const startTime = Date.now();
        let result: Awaited<ReturnType<typeof agent.invoke>>;

        try {
            result = await agent.invoke(
                { messages: [{ role: "user", content: userPrompt }] },
                {
                    configurable:   { thread_id: jobId },
                    recursionLimit: this.maxIterations * 2,
                }
            );
            console.log(`[deepagent] [${jobId}] Deep Agent invocation completed successfully`);
        } catch (err) {
            console.error(`[deepagent] [${jobId}] Agent threw:`, err);
            return {
                storyId: story.id,
                verdict: "FAIL",
                reason:  `Agent threw: ${err instanceof Error ? err.message : String(err)}`,
                costUsd: 0,
                turns:   0,
            };
        }

        const elapsedMs = Date.now() - startTime;

        // Count AI turns
        const messages = (result as { messages?: unknown[] }).messages ?? [];
        const aiTurns  = messages.filter(
            (m: unknown) => typeof (m as { _getType?: () => string })._getType === "function"
                ? (m as { _getType(): string })._getType() === "ai"
                : (m as { role?: string }).role === "assistant"
        ).length;

        console.log(
            `[deepagent] [${jobId}] Done — turns≈${aiTurns} elapsed=${(elapsedMs / 1000).toFixed(1)}s`
        );

        // ── Parse verdict from REVIEW.json ───────────────────────────────────
        const verdict = await parseVerdict(jobDir, extractFinalText(messages));
        console.log(`[deepagent] [${jobId}] Parsed REVIEW.json verdict: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ""}`);

        return {
            storyId: story.id,
            verdict: verdict.verdict,
            ...(verdict.reason !== undefined && { reason: verdict.reason }),
            costUsd: 0, // deepagents SDK does not expose token counts directly
            turns:   aiTurns,
        };
    }
}
