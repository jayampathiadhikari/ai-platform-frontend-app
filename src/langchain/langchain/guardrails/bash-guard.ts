import { GIT_BRANCH_PREFIX } from "../../../shared/constants.js";

/**
 * Result of a guard check.
 */
export type GuardResult =
    | { blocked: false }
    | { blocked: true; reason: string };

/**
 * Patterns that are never safe for an automated dev agent to run.
 * Ported directly from the Claude SDK bash-guard — same ruleset, framework-agnostic.
 */
const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
    // Remote code execution via piping a download straight into a shell
    { pattern: /curl\s+.*\|\s*(ba)?sh/i,  reason: "Remote code execution via curl pipe is not allowed" },
    { pattern: /wget\s+.*\|\s*(ba)?sh/i,  reason: "Remote code execution via wget pipe is not allowed" },

    // Recursive deletes of absolute paths or home-relative paths
    { pattern: /rm\s+(-\w*r\w*f|-\w*f\w*r)\s+\//i, reason: "Recursive delete of absolute paths is not allowed" },
    { pattern: /rm\s+(-\w*r\w*f|-\w*f\w*r)\s+~/i,  reason: "Recursive delete of home-relative paths is not allowed" },

    // Privilege escalation
    { pattern: /\bsudo\b/i,  reason: "sudo is not allowed" },
    { pattern: /\bsu\s+-/i,  reason: "User switching is not allowed" },

    // Credential / secret stores
    { pattern: /~\/\.ssh\b/i,     reason: "Access to ~/.ssh is not allowed" },
    { pattern: /~\/\.aws\b/i,     reason: "Access to ~/.aws credentials is not allowed" },
    { pattern: /~\/\.gnupg\b/i,   reason: "Access to ~/.gnupg is not allowed" },
    { pattern: /\/etc\/passwd/i,  reason: "Access to /etc/passwd is not allowed" },
    { pattern: /\/etc\/shadow/i,  reason: "Access to /etc/shadow is not allowed" },

    // Container / cluster management
    { pattern: /\bdocker\b.*(run|exec|build)/i, reason: "Docker run/exec/build is not allowed" },
    { pattern: /\bkubectl\b/i,                  reason: "kubectl is not allowed" },

    // Forced git operations that bypass review
    { pattern: /git\s+push\s+.*--force/i, reason: "Force-push is not allowed; the platform manages pushes" },
    { pattern: /git\s+push\s+.*-f\b/i,   reason: "Force-push is not allowed; the platform manages pushes" },

    // System-wide package manager installs
    { pattern: /\b(apt|apt-get|yum|dnf|brew)\s+install\b/i, reason: "System-level package installs are not allowed" },
];

/**
 * Pure function — checks a bash command string against the blocklist.
 * Returns { blocked: false } if the command is safe, or { blocked: true, reason } if denied.
 *
 * This is framework-agnostic and can be called from any tool wrapper.
 */
export function checkBashGuard(command: string): GuardResult {
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
            return { blocked: true, reason };
        }
    }

    // git push is only allowed onto branches that start with the
    // platform-controlled prefix (e.g. "agent/") to prevent pushing to main.
    if (/\bgit\s+push\b/i.test(command)) {
        const explicitRef = command.match(/git\s+push(?:\s+\S+)?\s+(\S+)/i)?.[1];
        if (
            explicitRef &&
            explicitRef !== "HEAD" &&
            !explicitRef.startsWith(GIT_BRANCH_PREFIX)
        ) {
            return {
                blocked: true,
                reason: `git push is only allowed for branches prefixed with "${GIT_BRANCH_PREFIX}"`,
            };
        }
    }

    return { blocked: false };
}
