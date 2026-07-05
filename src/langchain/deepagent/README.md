# LangChain Deep Agent Implementation

This package implements the same Jira-story job pipeline as `langchain/langchain` but uses the **official [`deepagents`](https://www.npmjs.com/package/deepagents) npm package** from LangChain as the developer agent.

The `deepagents` SDK (`createDeepAgent`) is a production-ready agent harness built on top of LangChain and LangGraph. It ships with built-in task planning, a virtual filesystem, context summarization, subagent delegation, and Anthropic prompt caching — so none of those capabilities need to be hand-rolled.

---

## Why `deepagents` instead of plain `createReactAgent`?

| Capability | `langchain/langchain` (ReAct) | `langchain/deepagent` (Deep Agents SDK) |
|---|---|---|
| **Task planning** | Agent improvises as it goes | Built-in `write_todos` tool — structured, visible TODO list |
| **Filesystem** | Hand-rolled tools | Built-in `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls` |
| **Context management** | Context grows unbounded | Automatic summarization of long conversation history |
| **Subagent delegation** | Not supported | Built-in `task` tool — spawns ephemeral child agents in isolated windows |
| **Prompt caching** | Not enabled | Automatic for Anthropic models — reduces latency and cost |
| **Permissions** | Bash guardrail only | Declarative path-level `allow`/`deny` rules on the virtual filesystem |

---

## Directory Structure

```
src/langchain/deepagent/
├── index.ts                        # Public barrel — re-exports every symbol
│
├── agents/
│   └── dev-agent.ts                # DeepDevAgent — wraps createDeepAgent from the deepagents SDK
│
├── callbacks/
│   └── usage-tracker.ts            # Re-exports UsageTracker from langchain/langchain
│
├── guardrails/
│   └── bash-guard.ts               # Re-exports checkBashGuard from langchain/langchain
│
├── orchestrator/
│   ├── graph.ts                    # LangGraph StateGraph + runJob entry-point
│   ├── nodes.ts                    # Node factory functions (5 nodes)
│   ├── types.ts                    # GraphState interface
│   └── index.ts                    # Re-exports
│
└── tools/                          # Re-export shims (no duplication)
    ├── bash.ts
    ├── read-file.ts
    ├── write-edit-file.ts
    └── glob-grep.ts
```

> **Tools, callbacks, and guardrails** are re-exported from `langchain/langchain` — no duplication.

---

## Public API (`index.ts`)

| Export | Source |
|---|---|
| `DeepDevAgent` | `agents/dev-agent.ts` |
| `checkBashGuard` | re-exported from `langchain/langchain` |
| `UsageTracker`, `estimateCostUsd` | re-exported from `langchain/langchain` |
| `makeBashTool`, `makeReadFileTool`, etc. | re-exported from `langchain/langchain` |
| `runJob`, `buildGraph` | `orchestrator/graph.ts` |
| `GraphState` (type) | `orchestrator/types.ts` |

---

## Module Reference

### 1. `agents/dev-agent.ts` — `DeepDevAgent`

**Role:** Implements the `Agent` interface using `createDeepAgent` from the `deepagents` npm package. This is the core difference from `langchain/langchain` — the agent harness is the official SDK, not a hand-rolled `createReactAgent` loop.

#### Class: `DeepDevAgent`

```ts
class DeepDevAgent implements Agent {
    constructor(model?: string, maxIterations?: number)
    async run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult>
}
```

#### How `createDeepAgent` is configured

```ts
const agent = createDeepAgent({
    model:        llm,               // ChatAnthropic instance
    systemPrompt: SYSTEM_PROMPT,     // Software engineer persona
    tools:        [bashTool],        // Workspace-scoped bash (git, npm, tests)
    permissions: [
        { operations: ["read", "write"], paths: [`${jobDir}/**`], mode: "allow" },
        { operations: ["write"],         paths: ["/**"],           mode: "deny"  },
    ],
});
```

The harness automatically adds to the agent:
- `write_todos` — structured task-tracking tool
- `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls` — virtual filesystem
- Context summarization — compresses long conversation history automatically
- `task` tool — subagent delegation (spawns ephemeral child agents)
- Prompt caching — automatic for Anthropic models

#### Bash tool

A workspace-scoped `bash` tool is passed as a custom tool. Every command passes through `checkBashGuard` (the same pure regex-based guardrail used by `langchain/langchain`) before execution. Blocked patterns include: `sudo`, `rm -rf /`, `curl | sh`, force-push to protected branches, etc.

#### Verdict resolution

After the agent finishes, the verdict is read from `REVIEW.json` (written by the agent itself as its final step). If that file is missing, the verdict is inferred from keywords in the final AI message.

```ts
// REVIEW.json shape expected by the agent
{ "verdict": "PASS" | "FAIL" | "PARTIAL", "reason": "..." }
```

#### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` | Model used by the agent |
| `MAX_TURNS` | `60` | Maximum LLM turns per run (`recursionLimit = MAX_TURNS * 2`) |

---

### 2. `orchestrator/types.ts` — `GraphState`

The LangGraph state threaded through every node in the pipeline. Identical in shape to `langchain/langchain`'s `GraphState` — the `deepagents` SDK complexity is fully encapsulated inside `DeepDevAgent`.

```ts
interface GraphState {
    // Inputs
    jobId:   string;
    jiraId:  string;
    signal?: AbortSignal;

    // resolveTicket
    story?: JiraStory;

    // setupWorkspace
    workspace?: Workspace;

    // devAgent (DeepDevAgent result)
    devResult?: JobResult;

    // reviewAgent (promoted from devResult)
    reviewResult?: ReviewVerdict;

    // Retry bookkeeping
    retryCount: number;

    // Error short-circuit
    error?: string;
}
```

---

### 3. `orchestrator/graph.ts` — `buildGraph` & `runJob`

**Role:** Assembles the LangGraph `StateGraph` with 5 nodes. Structurally identical to `langchain/langchain/orchestrator/graph.ts` — only the agent node implementation differs.

#### Graph Topology

```
START
  │
  ▼
resolveTicket ──(error)──┐
  │                       │
  ▼                       │
setupWorkspace ──(error)──┤
  │                       │
  ▼                       │
devAgent ──(error)────────┤   ← createDeepAgent from deepagents SDK
  │   │                   │
  │   └──(FAIL, retry)────┘   ← loops back while retryCount < MAX_RETRIES
  │
  ▼
reviewAgent ──(error)─────┤   ← promotes devResult.verdict to reviewResult
  │                       │
  ▼                       ▼
postProcess ──(error)── teardown
  │                       │
  ▼                       ▼
END                       END
```

#### `routeAfterDevAgent`

Routes back to `devAgent` on a `FAIL` verdict while the retry budget remains (env: `MAX_RETRIES`, default `2`). Advances to `reviewAgent` on `PASS`, `PARTIAL`, or once retries are exhausted.

#### Function: `runJob(jiraId, jobId, contextProvider?): Promise<void>`

Same public signature as `langchain/langchain`. `recursionLimit` is set to `100`.

---

### 4. `orchestrator/nodes.ts` — Graph Node Factories

| Node | Behaviour |
|---|---|
| `makeResolveTicketNode` | Fetches Jira ticket, parses `@agent` directive, loads CLAUDE.md, builds `JiraStory` |
| `makeSetupWorkspaceNode` | Clones repo, creates agent branch, writes TASK.md and CLAUDE.md |
| `makeDevAgentNode` | Instantiates `DeepDevAgent`, calls `.run()`, stores result in `state.devResult` |
| `makeReviewAgentNode` | Promotes `devResult.verdict` to `state.reviewResult` (pass-through stub) |
| `makePostProcessNode` | Opens GitHub PR for PASS/PARTIAL, marks job done, pushes branch, tears down workspace |
| `makeTeardownNode` | Error path — marks job failed, removes workspace clone without pushing |

---

## End-to-End Data Flow

```
POST /run/deepagent  →  runJob(jiraId, jobId)
                              │
          [resolveTicket]  → fetch Jira ticket, parse @agent directive, load CLAUDE.md
                              │
          [setupWorkspace] → clone repo, create agent branch, write TASK.md + CLAUDE.md
                              │
          [devAgent]       → createDeepAgent harness (deepagents SDK)
                │                 
                │  harness capabilities used at runtime:
                │    • write_todos  — agent plans its work as a structured task list
                │    • read_file, write_file, edit_file, glob, grep, ls  — file access
                │    • bash (custom)  — git commits, npm test, etc.
                │    • task (built-in) — delegate subtasks to child subagents if needed
                │    • summarization  — automatic, keeps context within token limits
                │  
                │  agent writes REVIEW.json before finishing, then the node reads it
                │
          [reviewAgent]   → promotes devAgent verdict to reviewResult (no extra LLM call)
                │
          [postProcess]   → open GitHub PR (PASS/PARTIAL), mark job done,
                │            push branch, tear down workspace
                │
               END
```

---

## HTTP Endpoint

```http
POST /run/deepagent
Content-Type: application/json

{ "jiraId": "PROJ-42" }
```

**Response:**
```json
{ "ok": true, "jobId": "...", "agent": "deepagent" }
```

Job status and cancellation use the shared registry endpoints:
- `GET /jobs/:id`
- `POST /jobs/:id/cancel`

---

## Comparison: `langchain/langchain` vs `langchain/deepagent`

| Dimension | `langchain/langchain` | `langchain/deepagent` |
|---|---|---|
| **Agent harness** | `createReactAgent` (LangGraph prebuilt) | `createDeepAgent` (deepagents SDK) |
| **Task planning** | Implicit — agent decides | Explicit `write_todos` built into harness |
| **Filesystem** | Hand-rolled tools (read-file, write-edit-file, glob-grep) | Built-in SDK tools |
| **Context management** | None — context grows until token limit | Automatic summarization |
| **Subagent support** | ✗ | ✓ Built-in `task` tool |
| **Prompt caching** | ✗ | ✓ Automatic for Anthropic |
| **Bash guardrail** | `checkBashGuard` (shared) | `checkBashGuard` (same, re-exported) |
| **Graph nodes** | 5 | 5 (identical structure) |
| **Public API** | `runJob`, `buildGraph`, `GraphState` | Same |

Both pipelines expose the same `runJob` / `buildGraph` / `GraphState` surface and are wired into the job registry — switching between them is a drop-in replacement at the HTTP layer.
