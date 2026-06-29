import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import type { Serialized } from "@langchain/core/load/serializable";

/**
 * Accumulated usage across all LLM calls in one agent run.
 */
export interface UsageSummary {
    inputTokens: number;
    outputTokens: number;
    llmCalls: number;
}

/**
 * LangChain callback that accumulates token usage across all LLM calls.
 *
 * Attach one instance per agent run, then read `.summary` at the end.
 * Token-to-USD conversion is intentionally left to the caller — prices
 * differ per model and change over time.
 *
 * Usage:
 *   const tracker = new UsageTracker();
 *   await agent.invoke({ messages }, { callbacks: [tracker] });
 *   console.log(tracker.summary);
 */
export class UsageTracker extends BaseCallbackHandler {
    name = "UsageTracker";

    private inputTokens  = 0;
    private outputTokens = 0;
    private llmCalls     = 0;

    /** Called once per LLM call with the final result. */
    override async handleLLMEnd(output: LLMResult): Promise<void> {
        this.llmCalls++;

        // LangChain surfaces token usage in different places depending on the
        // provider integration. We check both the top-level `llmOutput` and
        // per-generation metadata to be provider-agnostic.
        const topLevel = output.llmOutput?.tokenUsage ?? output.llmOutput?.usage;
        if (topLevel) {
            this.inputTokens  += topLevel.promptTokens     ?? topLevel.input_tokens  ?? 0;
            this.outputTokens += topLevel.completionTokens ?? topLevel.output_tokens ?? 0;
            return;
        }

        // Fallback: walk per-generation usage_metadata (Anthropic / Gemini)
        for (const gen of output.generations.flat()) {
            const meta = (gen as { generationInfo?: { usage_metadata?: Record<string, number> } })
                .generationInfo?.usage_metadata;
            if (meta) {
                this.inputTokens  += meta.input_tokens  ?? 0;
                this.outputTokens += meta.output_tokens ?? 0;
            }
        }
    }

    /** Reset counters — call before re-using the same tracker instance. */
    reset(): void {
        this.inputTokens  = 0;
        this.outputTokens = 0;
        this.llmCalls     = 0;
    }

    get summary(): UsageSummary {
        return {
            inputTokens:  this.inputTokens,
            outputTokens: this.outputTokens,
            llmCalls:     this.llmCalls,
        };
    }

    // Required no-op to satisfy abstract base
    override async handleChainStart(_chain: Serialized): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Approximate cost helper (Claude Haiku 3.5 pricing as of 2025-Q2)
// Update these constants when Anthropic changes pricing.
// ---------------------------------------------------------------------------
const COST_PER_1K_INPUT_USD  = 0.00025; // $0.25 / 1M input tokens
const COST_PER_1K_OUTPUT_USD = 0.00125; // $1.25 / 1M output tokens

export function estimateCostUsd(summary: UsageSummary): number {
    return (
        (summary.inputTokens  / 1000) * COST_PER_1K_INPUT_USD +
        (summary.outputTokens / 1000) * COST_PER_1K_OUTPUT_USD
    );
}
