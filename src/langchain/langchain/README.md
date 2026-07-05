# LangChain Agent Implementation

This package is a **LangChain/LangGraph-backed drop-in replacement** for the `claude-sdk` orchestration pipeline. It implements the same `Agent` interface and `runJob` / `buildGraph` public API, but uses `@langchain/langgraph` for graph execution and `@langchain/anthropic` for LLM calls — making it interchangeable with the Claude SDK variant without changes to the shared job registry or workspace manager.

---

## Directory Structure

```
src/langchain/langchain/
├── index.ts                    # Public barrel — re-exports every symbol
│
├── agents/
│   └── dev-agent.ts            # LangChainDevAgent — the ReAct coding agent
│
├── callbacks/
│   └── usage-tracker.ts        # Token & cost tracking callback
│
├── guardrails/
│   └── bash-guard.ts           # Pure-function command-safety enforcer
│
├── orchestrator/
│   ├── graph.ts                # LangGraph StateGraph assembly + runJob entry-point
│   ├── nodes.ts                # Individual graph node factory functions
│   ├── types.ts                # GraphState interface + routing type aliases
│   └── index.ts                # Re-exports graph.ts + types.ts
│
└── tools/
    ├── bash.ts                 # Bash execution tool (workspace-scoped)
    ├── read-file.ts            # File reader tool
    ├── write-edit-file.ts      # File writer + surgical find-and-replace tool
    └── glob-grep.ts            # Glob file finder + regex grep tool
```

---

## Public API (`index.ts`)

`index.ts` is the single barrel file that surfaces every reusable symbol:

| Export | Source |
|---|---|
| `LangChainDevAgent` | `agents/dev-agent.ts` |
| `checkBashGuard` | `guardrails/bash-guard.ts` |
| `UsageTracker`, `estimateCostUsd` | `callbacks/usage-tracker.ts` |
| `makeBashTool` | `tools/bash.ts` |
| `makeReadFileTool` | `tools/read-file.ts` |
| `makeWriteFileTool`, `makeEditFileTool` | `tools/write-edit-file.ts` |
| `makeGlobTool`, `makeGrepTool` | `tools/glob-grep.ts` |
| `runJob`, `buildGraph` | `orchestrator/graph.ts` |
| `GraphState` (type) | `orchestrator/types.ts` |

Consumers should import exclusively from this barrel rather than from leaf files to remain insulated from internal refactors.

---

## Module Reference

### 1. `agents/dev-agent.ts` — `LangChainDevAgent`

**Role:** The primary autonomous coding agent. Implements the shared `Agent` interface so it is a plug-in replacement for the Claude SDK's `DevAgent`.

#### Class: `LangChainDevAgent`

```ts
class LangChainDevAgent implements Agent {
  constructor(maxTurns?: number, model?: string)
  async run(story: JiraStory, workspace: Workspace, signal?: AbortSignal): Promise<JobResult>
}
```

**How it works (step-by-step inside `run`):**

| Step | What happens |
|---|---|
| **1 — Build tools** | Instantiates six workspace-scoped LangChain tools (`bash`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`). Each tool receives the `jobDir` so it cannot escape the workspace. |
| **2 — Build LLM** | Creates a `ChatAnthropic` instance (`temperature: 0`, `maxTokens: 8192`). Model and turn limit are configurable via `ANTHROPIC_MODEL` / `MAX_TURNS` env vars (defaults: `claude-haiku-4-5` / `60`). |
| **3 — Build ReAct graph** | Calls `createReactAgent({ llm, tools, messageModifier })`. The `messageModifier` injects the `SYSTEM_PROMPT` before every LLM call. The ReAct loop continues until the LLM produces a response with no tool calls or `recursionLimit` is hit. |
| **4 — Attach tracker** | Attaches a `UsageTracker` callback instance to collect token counts. |
| **5 — Run** | Invokes the agent graph with `agent.invoke(...)`. `recursionLimit` is set to `maxTurns * 2` (each agent turn = 1 LLM node + 1 tool node). |
| **6 — Parse result** | Reads the `REVIEW.json` file the agent is instructed to write. Falls back to text heuristics (scanning the final AI message for "pass" / "partial") if `REVIEW.json` is missing. |

**System prompt contract:**
The agent is told to read `TASK.md` and `CLAUDE.md` first, implement the story, commit and push the branch, and then write `REVIEW.json` with a `{ "verdict": "PASS" | "FAIL" | "PARTIAL", "reason": "..." }` object.

**Key constants:**

| Constant | Default | Env var |
|---|---|---|
| `MAX_TURNS` | `60` | `MAX_TURNS` |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` | `ANTHROPIC_MODEL` |

---

### 2. `callbacks/usage-tracker.ts` — `UsageTracker` & `estimateCostUsd`

**Role:** Aggregates token usage across every LLM call in a single agent run and provides a cost estimate.

#### Class: `UsageTracker extends BaseCallbackHandler`

```ts
class UsageTracker extends BaseCallbackHandler {
  get summary(): UsageSummary   // { inputTokens, outputTokens, llmCalls }
  reset(): void
}
```

**How it works:**

- Extends LangChain's `BaseCallbackHandler` so it can be passed directly in `agent.invoke({ callbacks: [tracker] })`.
- Overrides `handleLLMEnd(output: LLMResult)` which is called once after every LLM response. It tries two token-extraction strategies in order:
  1. `output.llmOutput?.tokenUsage` / `output.llmOutput?.usage` — standard OpenAI-style keys (`promptTokens`, `completionTokens`).
  2. Per-generation `generationInfo.usage_metadata` — Anthropic/Gemini-style keys (`input_tokens`, `output_tokens`).
- This dual-path approach makes the tracker **provider-agnostic**.

#### Function: `estimateCostUsd(summary: UsageSummary): number`

Converts token counts to USD using hard-coded Claude Haiku 3.5 rates (2025-Q2):

| Token type | Rate |
|---|---|
| Input | $0.00025 / 1K tokens ($0.25 / 1M) |
| Output | $0.00125 / 1K tokens ($1.25 / 1M) |

> **Note:** Update `COST_PER_1K_INPUT_USD` / `COST_PER_1K_OUTPUT_USD` in `usage-tracker.ts` when Anthropic changes pricing.

---

### 3. `guardrails/bash-guard.ts` — `checkBashGuard`

**Role:** A **pure, stateless function** that inspects a bash command string and blocks dangerous patterns before they are executed. It is framework-agnostic and shared by both the LangChain and Claude SDK implementations.

#### Function: `checkBashGuard(command: string): GuardResult`

```ts
type GuardResult = { blocked: false } | { blocked: true; reason: string };
```

Returns `{ blocked: false }` for safe commands; `{ blocked: true, reason }` for disallowed ones.

**Blocked patterns by category:**

| Category | Examples blocked |
|---|---|
| Remote code execution | `curl ... \| sh`, `wget ... \| bash` |
| Destructive deletes | `rm -rf /`, `rm -rf ~` |
| Privilege escalation | `sudo ...`, `su -` |
| Credential store access | `~/.ssh`, `~/.aws`, `~/.gnupg`, `/etc/passwd`, `/etc/shadow` |
| Container management | `docker run/exec/build`, `kubectl` |
| Forced git operations | `git push --force`, `git push -f` |
| System package installs | `apt install`, `brew install`, `yum install` |

**Branch-name enforcement:**
`git push` is additionally checked against `GIT_BRANCH_PREFIX` (imported from shared constants). Pushes to branches that do not start with the platform prefix (e.g. `agent/`) are blocked to prevent accidental pushes to `main` / `master`.

---

### 4. `orchestrator/types.ts` — `GraphState`

**Role:** Defines the **LangGraph state type** that flows through every node in the pipeline.

#### Interface: `GraphState`

```ts
interface GraphState {
  // Inputs (set at invocation)
  jobId:   string;
  jiraId:  string;
  signal?: AbortSignal;       // Propagated from job registry for cancellation

  // Populated by resolveTicket
  story?: JiraStory;

  // Populated by setupWorkspace
  workspace?: Workspace;

  // Written by devAgent
  devResult?: JobResult;

  // Written by reviewAgent
  reviewResult?: ReviewVerdict;

  // Retry bookkeeping
  retryCount: number;

  // Error short-circuit — any node can set this to route to teardown
  error?: string;
}
```

#### Routing type aliases

```ts
type AfterDevAgent    = "reviewAgent" | "devAgent" | "teardown";
type AfterReviewAgent = "postProcess" | "teardown";
```

These types constrain the return values of the conditional edge routing functions in `graph.ts`, making invalid transitions a compile-time error.

---

### 5. `orchestrator/graph.ts` — `buildGraph` & `runJob`

**Role:** Assembles the LangGraph `StateGraph` and exposes the top-level `runJob` entry point.

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
planStory                 │
  │                       │
  ▼                       │
devAgent ──(error)────────┤
  │                       │
  ├──(FAIL + retries left)─┘  ← loops back to devAgent
  │
  ▼
reviewAgent ──(error)─────┤
  │                       │
  ▼                       ▼
postProcess ──(error)── teardown
  │                       │
  ▼                       ▼
 END                      END
```

#### `OrchestratorState`

The graph state is defined using `Annotation.Root(...)` — LangGraph's internal constraint requires individual `Annotation<T>()` declarations rather than a raw TypeScript interface. The `retryCount` field has a custom `reducer` that replaces the previous value on each update.

#### Routing helpers

| Helper | Behaviour |
|---|---|
| `routeAfterDevAgent` | Returns `"devAgent"` (retry) if verdict is `"FAIL"` and `retryCount < MAX_RETRIES`; otherwise `"reviewAgent"` or `"teardown"` on error. |
| `routeAfterReviewAgent` | Returns `"teardown"` if `state.error` is set, else `"postProcess"`. |
| `routeOnError(next)` | Generic factory — routes to `"teardown"` on error, otherwise to `next`. |

#### Function: `buildGraph(contextProvider?): CompiledGraph`

Wires all nodes and conditional edges, then calls `graph.compile()`. Accepts an optional `ContextProvider` (defaults to `MockJiraContextProvider`).

#### Function: `runJob(jiraId, jobId, contextProvider?): Promise<void>`

Top-level entry point. Mirrors the claude-sdk `runJob` signature exactly.

1. Calls `registerJob(jobId, jiraId)` to obtain an `AbortController` (used for job cancellation via the API).
2. Builds and invokes the compiled graph with `recursionLimit: 100`.
3. On unhandled error: calls `finishJob(jobId, "cancelled" | "failed")` and logs accordingly.

---

### 6. `orchestrator/nodes.ts` — Graph Node Factories

**Role:** Contains one factory function per graph node. Each factory **closes over** its configuration and returns a `NodeFn: (state: GraphState) => Promise<Partial<GraphState>>`.

#### Node 1: `makeResolveTicketNode(contextProvider)`

1. Fetches the Jira ticket via `contextProvider.getTicket(jiraId)`.
2. Parses the `@agent` directive from ticket comments using `parseAgentDirective` (from the shared claude-sdk orchestrator helpers).
3. Loads `CLAUDE.md` (the agent's operational guidelines) from the filesystem.
4. Assembles and returns a `JiraStory` object for downstream nodes.
5. On any failure, sets `state.error` to short-circuit to teardown.

#### Node 2: `makeSetupWorkspaceNode()`

Calls `setupWorkspace(story)` from the shared workspace manager, which:
- Clones the target git repo.
- Creates the agent branch.
- Writes `TASK.md` and `CLAUDE.md` into the workspace root.

Returns the `Workspace` object (contains `jobId`, `jobDir`, `branch`, `remoteUrl`).

#### Node 3: `makePlanStoryNode()` *(stub)*

Currently a **pass-through**. Intended as a hook for a future `PlannerAgent` that could decompose or annotate a story before it reaches the dev agent. Returns `{}` (no state changes).

#### Node 4: `makeDevAgentNode()`

1. Instantiates `LangChainDevAgent` and calls `agent.run(story, workspace, signal)`.
2. On `"FAIL"` verdict, increments `retryCount` in the returned state so the router can decide whether to retry.
3. On exception, sets `state.error`.

#### Node 5: `makeReviewAgentNode()` *(stub)*

Currently promotes the `devResult.verdict` directly to `reviewResult`. Intended as a hook for an independent LLM-based code reviewer that inspects the diff. Returns `{ reviewResult }`.

#### Node 6: `makePostProcessNode()`

1. Opens a GitHub PR via `createPullRequest(...)` for `PASS` or `PARTIAL` verdicts. PR creation failure is **non-fatal** (logged as an error but execution continues).
2. Calls `finishJob(jobId, "done")` to update the job registry.
3. Calls `pushAndTeardown(workspace)` to push the branch and delete the local clone.

#### Node 7: `makeTeardownNode()` *(error path)*

Called whenever `state.error` is set by any earlier node.

1. Calls `finishJob(jobId, "failed")`.
2. Calls `teardownWorkspace(workspace)` if a workspace was created (deletes the clone without pushing).

---

### 7. `tools/bash.ts` — `makeBashTool`

**Role:** LangChain `tool()` wrapper around `child_process.exec`.

```
Tool name:    "bash"
Input schema: { command: string, timeout?: number (default 30 000 ms) }
```

**Safety:** Calls `checkBashGuard(command)` before execution. If blocked, returns `"BLOCKED: <reason>"` without running the command.

**Workspace isolation:** The `cwd` is bound at construction time — all commands run inside the job's workspace directory regardless of what path the command itself specifies.

**Output:** Combined `stdout` + `stderr` (separated by `---stderr---`). Max buffer is 10 MB. On error, returns the error message + stderr.

---

### 8. `tools/read-file.ts` — `makeReadFileTool`

**Role:** Allows the agent to read files from its workspace with optional line-range slicing.

```
Tool name:    "read_file"
Input schema: { file_path: string, start_line?: number, end_line?: number }
```

- Both absolute and relative paths are accepted; relative paths are resolved against `cwd`.
- Path traversal is blocked — any path that resolves outside `cwd` returns an access-denied error.
- `start_line` / `end_line` are 1-indexed and inclusive, matching typical editor conventions.

---

### 9. `tools/write-edit-file.ts` — `makeWriteFileTool` & `makeEditFileTool`

**Role:** Two complementary file-mutation tools.

#### `makeWriteFileTool` — `write_file`

```
Input schema: { file_path: string, content: string, create_dirs?: boolean (default true) }
```

Creates or **fully overwrites** a file. Parent directories are created automatically. Best used for new files or complete rewrites.

#### `makeEditFileTool` — `edit_file`

```
Input schema: { file_path: string, old_string: string, new_string: string }
```

Performs a **surgical find-and-replace**. Fails fast with an error message if:

- `old_string` is not found in the file (0 occurrences).
- `old_string` appears more than once (ambiguous match — the agent must provide more surrounding context).

This two-tool design mirrors the Claude SDK's own tool surface, keeping agent prompts transferable between implementations.

---

### 10. `tools/glob-grep.ts` — `makeGlobTool` & `makeGrepTool`

**Role:** File discovery and content search, implemented without third-party glob libraries using a recursive `walkGlob` utility and a hand-rolled `globToRegExp` converter.

#### `makeGlobTool` — `glob`

```
Tool name:    "glob"
Input schema: { pattern: string, ignore?: string[] }
```

- Walks the workspace directory tree recursively.
- Converts the glob pattern to a `RegExp` (handles `**`, `*`, `?`, and character classes).
- Default ignore list: `node_modules`, `.git`, `dist`.
- Returns newline-separated relative paths.

#### `makeGrepTool` — `grep`

```
Tool name:    "grep"
Input schema: { pattern: string, path?: string, include?: string, case_insensitive?: boolean, max_results?: number }
```

- Collects candidate files via `walkGlob`, then reads each file and tests every line against the pattern.
- `include` further filters candidates by basename glob (e.g. `*.ts`).
- Returns matches in `file:line: content` format (same as `grep -n`).
- Hard-caps results at `max_results` (default 50) to prevent overwhelming the LLM context window.
- Path traversal is blocked — `path` is resolved against `cwd` and validated.

---

## End-to-End Data Flow

```
runJob(jiraId, jobId)
      │
      ▼
  buildGraph()
      │
      ▼
 [resolveTicket]  → fetches ticket, parses @agent directive, loads CLAUDE.md
      │
      ▼
 [setupWorkspace] → clones repo, creates branch, writes TASK.md + CLAUDE.md
      │
      ▼
 [planStory]      → (stub) pass-through
      │
      ▼
 [devAgent]       → runs LangChainDevAgent (ReAct loop with 6 tools)
      │                 ↑ retried up to MAX_RETRIES times on FAIL verdict
      │
      ▼
 [reviewAgent]    → (stub) promotes devResult verdict to reviewResult
      │
      ▼
 [postProcess]    → opens GitHub PR, marks job done, pushes & tears down workspace
      │
      ▼
     END
```

Any node that encounters an error sets `state.error`, which routes the graph to `[teardown]` — which removes the workspace clone (without pushing) and marks the job as failed.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` | Anthropic model used by `LangChainDevAgent` |
| `MAX_TURNS` | `60` | Maximum ReAct agent turns per run |
| `MAX_RETRIES` | `2` | Maximum dev-agent retry attempts on FAIL verdict |

---

## External Dependencies

| Package | Used by | Purpose |
|---|---|---|
| `@langchain/anthropic` | `dev-agent.ts` | `ChatAnthropic` LLM wrapper |
| `@langchain/langgraph` | `graph.ts`, `dev-agent.ts` | `StateGraph`, `createReactAgent` |
| `@langchain/core` | all modules | `BaseCallbackHandler`, `tool()`, message types |
| `zod` | all tools | Input schema validation |
