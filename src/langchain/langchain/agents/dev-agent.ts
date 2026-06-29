import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import type { JiraStory, Workspace } from "../../../shared/workspace-manager/types.js";

import { checkBashGuard } from "../guardrails/bash-guard.js";
import { makeBashTool }                        from "../tools/bash.js";
import { makeReadFileTool }                    from "../tools/read-file.js";
import { makeWriteFileTool, makeEditFileTool } from "../tools/write-edit-file.js";
import { makeGlobTool, makeGrepTool }          from "../tools/glob-grep.js";
import { UsageTracker, estimateCostUsd }       from "../callbacks/usage-tracker.js";

import fs   from "fs/promises";
import path from "path";
import type { Agent, JobResult, ReviewVerdict } from "../../types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_TURNS      = Number(process.env.MAX_TURNS      ?? "60");
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL     ?? "claude-haiku-4-5";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `\
You are a senior software engineer working autonomously inside an isolated git workspace.

Your operational guidelines are in CLAUDE.md and your task specification is in TASK.md — 
both files are in your current working directory. Read them before doing anything else.

When you are done implementing the story:
1. Commit all changes on the current branch (git add -A && git commit -m "...")
2. Push the branch to origin (git push origin HEAD)
3. Write a REVIEW.json file in the workspace root with exactly this shape:
   { "verdict": "PASS" | "FAIL" | "PARTIAL", "reason": "..." }

Do NOT open a pull request — the platform handles that automatically.
Do NOT push to main, master, or develop — only push to the current agent branch.
`;

// ---------------------------------------------------------------------------
// LangChain dev agent — implements the same Agent interface as the Claude SDK
// version so it is a drop-in replacement in the orchestrator.
// ---------------------------------------------------------------------------
export class LangChainDevAgent implements Agent {
    private readonly maxTurns: number;
    private readonly model:    string;

    constructor(maxTurns = MAX_TURNS, model = ANTHROPIC_MODEL) {
        this.maxTurns = maxTurns;
        this.model    = model;
    }

    async run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult> {
        const { jobId, jobDir } = workspace;

        console.log(`[lc-agent] [${jobId}] Starting — story=${story.id} cwd=${jobDir}`);
        console.log(`[lc-agent] [${jobId}] Model=${this.model} maxTurns=${this.maxTurns}`);

        // ── 1. Build workspace-scoped tools ─────────────────────────────────
        const tools = [
            makeBashTool(jobDir, checkBashGuard),
            makeReadFileTool(jobDir),
            makeWriteFileTool(jobDir),
            makeEditFileTool(jobDir),
            makeGlobTool(jobDir),
            makeGrepTool(jobDir),
        ];

        // ── 2. Build the LLM ────────────────────────────────────────────────
        const llm = new ChatAnthropic({
            model:       this.model,
            temperature: 0,
            maxTokens:   8192,
            ...(signal ? { signal } : {}),
        });

        // ── 3. Build the ReAct agent graph ───────────────────────────────────
        //
        // createReactAgent wires:
        //   HumanMessage → LLM → (tool calls) → ToolMessages → LLM → …
        // It stops when the LLM produces a response with no tool calls,
        // or when recursionLimit is hit.
        const agent = createReactAgent({
            llm,
            tools,
            messageModifier: SYSTEM_PROMPT, // injected as SystemMessage before every LLM call
        });

        // ── 4. Usage tracking ────────────────────────────────────────────────
        const tracker = new UsageTracker();

        // ── 5. Build initial messages ────────────────────────────────────────
        const initialMessages = [
            new HumanMessage(this.buildPrompt(story)),
        ];

        // ── 6. Run ───────────────────────────────────────────────────────────
        console.log(`[lc-agent] [${jobId}] Invoking agent graph...`);

        let turnCount = 0;

        const result = await agent.invoke(
            { messages: initialMessages },
            {
                recursionLimit: this.maxTurns * 2, // each turn = 1 LLM + 1 tool node
                callbacks: [tracker],
                configurable: { thread_id: jobId },
            }
        );

        // Count assistant turns (AIMessage with no tool calls = a "thinking" turn)
        for (const msg of result.messages) {
            if (msg._getType() === "ai") turnCount++;
        }

        const usage    = tracker.summary;
        const costUsd  = estimateCostUsd(usage);

        console.log(
            `[lc-agent] [${jobId}] Done — turns≈${turnCount} ` +
            `in=${usage.inputTokens} out=${usage.outputTokens} ` +
            `cost≈$${costUsd.toFixed(4)}`
        );

        // ── 7. Parse verdict ─────────────────────────────────────────────────
        const finalText = this.extractFinalText(result.messages);
        const verdict   = await this.parseVerdict(jobDir, finalText);

        console.log(`[lc-agent] [${jobId}] Verdict: ${verdict.verdict}${verdict.reason ? ` — ${verdict.reason}` : ""}`);

        return {
            storyId: story.id,
            verdict: verdict.verdict,
            ...(verdict.reason !== undefined && { reason: verdict.reason }),
            costUsd,
            turns: turnCount,
        };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private buildPrompt(story: JiraStory): string {
        return `\
You are implementing Jira story ${story.id}.

The full task specification is in TASK.md and your operational guidelines are in CLAUDE.md.
Both files are in your current working directory.

Begin by reading TASK.md and CLAUDE.md, then implement the story.`.trim();
    }

    /** Pull the text content from the last AIMessage in the result. */
    private extractFinalText(messages: { _getType(): string; content: unknown }[]): string {
        const aiMessages = messages.filter((m) => m._getType() === "ai");
        if (aiMessages.length === 0) return "";

        const last = aiMessages[aiMessages.length - 1];
        if (!last) return "";

        if (typeof last.content === "string") return last.content;
        if (Array.isArray(last.content)) {
            return last.content
                .filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
                .map((b) => b.text)
                .join("\n");
        }
        return "";
    }

    /**
     * Read REVIEW.json written by the agent; fall back to text heuristics.
     * Mirrors the same logic in the Claude SDK DevAgent.
     */
    private async parseVerdict(jobDir: string, finalText: string): Promise<ReviewVerdict> {
        const reviewPath = path.join(jobDir, "REVIEW.json");
        try {
            const raw  = await fs.readFile(reviewPath, "utf8");
            const json = JSON.parse(raw) as ReviewVerdict;
            console.log(`[lc-agent] REVIEW.json read successfully`);
            return json;
        } catch {
            console.warn(`[lc-agent] REVIEW.json not found — inferring verdict from final message`);
            const lower = finalText.toLowerCase();
            if (lower.includes("pass"))    return { verdict: "PASS",    reason: "inferred from output" };
            if (lower.includes("partial")) return { verdict: "PARTIAL", reason: "inferred from output" };
            console.error(`[lc-agent] Could not infer verdict — defaulting to FAIL`);
            return { verdict: "FAIL", reason: "REVIEW.json not found" };
        }
    }
}
