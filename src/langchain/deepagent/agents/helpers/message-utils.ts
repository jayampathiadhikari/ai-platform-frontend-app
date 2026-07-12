import path from "path";
import fs from "fs/promises";
import type { ReviewVerdict } from "../../../types.js";

// ---------------------------------------------------------------------------
// extractFinalText
// ---------------------------------------------------------------------------
// Pulls the plain-text content from the last AI message in a LangChain
// message array (supports both role-based and _getType()-based messages).
// ---------------------------------------------------------------------------

export function extractFinalText(messages: unknown[]): string {
    const aiMsgs = messages.filter(
        (m: unknown) => (m as { role?: string }).role === "assistant"
            || (typeof (m as { _getType?: () => string })._getType === "function"
                && (m as { _getType(): string })._getType() === "ai")
    );
    if (aiMsgs.length === 0) return "";

    const last    = aiMsgs[aiMsgs.length - 1] as { content: unknown };
    const content = last.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return (content as { type?: string; text?: string }[])
            .filter((b) => b.type === "text")
            .map((b)   => b.text ?? "")
            .join("\n");
    }
    return "";
}

// ---------------------------------------------------------------------------
// parseVerdict
// ---------------------------------------------------------------------------
// Reads /REVIEW.json from the job workspace. Falls back to keyword-matching
// against the final AI message when the file is absent.
// ---------------------------------------------------------------------------

export async function parseVerdict(jobDir: string, finalText: string): Promise<ReviewVerdict> {
    const reviewPath = path.join(jobDir, "REVIEW.json");
    try {
        const raw  = await fs.readFile(reviewPath, "utf8");
        const json = JSON.parse(raw) as ReviewVerdict;
        console.log("[deepagent] REVIEW.json read successfully");
        return json;
    } catch {
        console.warn("[deepagent] REVIEW.json not found — inferring verdict from final message");
        const lower = finalText.toLowerCase();
        if (lower.includes("pass"))    return { verdict: "PASS",    reason: "inferred from output" };
        if (lower.includes("partial")) return { verdict: "PARTIAL", reason: "inferred from output" };
        return { verdict: "FAIL", reason: "REVIEW.json not found" };
    }
}
