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

// ---------------------------------------------------------------------------
// sanitizeMessages
// ---------------------------------------------------------------------------
// Sanitizes LLM input message histories by converting invalid/binary file
// blocks (non-PDF) into text blocks or safe text placeholders.
// ---------------------------------------------------------------------------

export function sanitizeMessages(input: any): any {
    if (!input) return input;
    if (Array.isArray(input)) {
        return input.map(sanitizeMessage);
    }
    if (typeof input === "object" && input.messages) {
        return {
            ...input,
            messages: sanitizeMessages(input.messages)
        };
    }
    return sanitizeMessage(input);
}

function sanitizeMessage(message: any): any {
    if (!message || typeof message !== "object") return message;

    let content = message.content;
    if (content === undefined && message.lc_kwargs) {
        content = message.lc_kwargs.content;
    }

    if (Array.isArray(content)) {
        let hasChanges = false;
        const sanitizedContent = content.map((block: any) => {
            if (block && typeof block === "object") {
                // 1. Raw file block from deepagents tool output
                if (block.type === "file") {
                    const mime = block.mimeType || block.mime_type;
                    if (mime && mime !== "application/pdf") {
                        hasChanges = true;
                        if (block.data && typeof block.data === "string") {
                            try {
                                const decoded = Buffer.from(block.data, "base64").toString("utf8");
                                const isBinary = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded);
                                if (!isBinary) {
                                    return { type: "text", text: decoded };
                                }
                            } catch {
                                // fallback to placeholder
                            }
                        }
                        return {
                            type: "text",
                            text: `[File Content (${mime}): Binary/Unsupported format. Length = ${block.data?.length ?? 0} characters]`
                        };
                    }
                }

                // 2. Mapped document block
                if (block.type === "document" && block.source?.type === "base64") {
                    const mediaType = block.source.media_type;
                    if (mediaType && mediaType !== "application/pdf") {
                        hasChanges = true;
                        if (block.source.data && typeof block.source.data === "string") {
                            try {
                                const decoded = Buffer.from(block.source.data, "base64").toString("utf8");
                                const isBinary = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(decoded);
                                if (!isBinary) {
                                    return { type: "text", text: decoded };
                                }
                            } catch {
                                // fallback to placeholder
                            }
                        }
                        return {
                            type: "text",
                            text: `[Document (${mediaType}): Unsupported binary format]`
                        };
                    }
                }
            }
            return block;
        });

        if (hasChanges) {
            const clonedMessage = Object.create(Object.getPrototypeOf(message));
            Object.assign(clonedMessage, message);
            if (clonedMessage.lc_kwargs) {
                clonedMessage.lc_kwargs = { ...clonedMessage.lc_kwargs, content: sanitizedContent };
            }
            clonedMessage.content = sanitizedContent;
            return clonedMessage;
        }
    }
    return message;
}
