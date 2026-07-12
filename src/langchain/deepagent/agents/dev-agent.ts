import { createDeepAgent, FilesystemBackend } from "deepagents";
import { ChatAnthropic } from "@langchain/anthropic";
import { IterableReadableStream } from "@langchain/core/utils/stream";

import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";
import type { Agent, JobResult } from "../../types.js";
import { makeBashTool } from "./helpers/bash-runner.js";
import { extractFinalText, parseVerdict, sanitizeMessages } from "./helpers/message-utils.js";
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

        // ── Build the model ─────────────────────────────────────────────────────
        const llm = new ChatAnthropic({
            model:       this.model,
            temperature: 1,   // extended thinking requires temperature=1
            maxTokens:   10000,
            thinking: {
                type:         "enabled",
                budget_tokens: 3000,  // moderate — concise reasoning without full deliberation
            },
            ...(signal ? { signal } : {}),
        });

        // Intercept and sanitize inputs to prevent invalid media types from reaching the API,
        // and log any thinking blocks returned by the LLM.
        // Option 5: flag — first text block from the LLM is the agent's plan
        let firstTextLogged = false;

        const originalInvoke = llm.invoke.bind(llm);
        llm.invoke = async function (input, options) {
            const result = await originalInvoke(sanitizeMessages(input), options);
            if (result && typeof result === "object" && Array.isArray(result.content)) {
                for (const block of result.content) {
                    if (block && typeof block === "object") {
                        if (block.type === "thinking" && typeof block.thinking === "string") {
                            console.log(`[deepagent:thinking] ${block.thinking.replace(/\n/g, " ").trim()}`);
                        } else if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
                            if (!firstTextLogged) {
                                firstTextLogged = true;
                                console.log(`[deepagent:plan] ${block.text.replace(/\n/g, " ").trim()}`);
                            } else {
                                console.log(`[deepagent:response] ${block.text.replace(/\n/g, " ").trim()}`);
                            }
                        }
                    }
                }
            }
            return result;
        };

        const originalStream = llm.stream.bind(llm);
        llm.stream = async function (input, options) {
            const stream = await originalStream(sanitizeMessages(input), options);
            async function* wrapperGenerator() {
                let thinkingBuf = "";
                let textBuf = "";
                let inThinking = false;
                let inText = false;
                for await (const chunk of stream) {
                    if (chunk && typeof chunk === "object" && Array.isArray(chunk.content)) {
                        for (const block of chunk.content) {
                            if (block && typeof block === "object") {
                                if (block.type === "thinking" && typeof block.thinking === "string") {
                                    inThinking = true;
                                    thinkingBuf += block.thinking;
                                } else if (block.type === "text" && typeof block.text === "string" && block.text) {
                                    if (inThinking) {
                                        // Flush accumulated thinking as a single structured line
                                        console.log(`[deepagent:thinking] ${thinkingBuf.replace(/\n/g, " ").trim()}`);
                                        thinkingBuf = "";
                                        inThinking = false;
                                    }
                                    inText = true;
                                    textBuf += block.text;
                                }
                            }
                        }
                    }
                    yield chunk;
                }
                // Flush remaining text buffer as plan or response
                if (textBuf.trim()) {
                    const tag = firstTextLogged ? "[deepagent:response]" : "[deepagent:plan]";
                    firstTextLogged = true;
                    console.log(`${tag} ${textBuf.replace(/\n/g, " ").trim()}`);
                }
                if (inThinking && thinkingBuf.trim()) {
                    console.log(`[deepagent:thinking] ${thinkingBuf.replace(/\n/g, " ").trim()}`);
                }
            }
            return IterableReadableStream.fromAsyncGenerator(wrapperGenerator());
        };

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
