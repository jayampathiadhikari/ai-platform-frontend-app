# Why AI Agents Need Sandboxes

## Summary

AI agents like `DeepDevAgent` execute autonomously — they read files, write code, and run shell commands without human approval at each step. Without a sandbox, a single bad tool call can leak cloud credentials, destroy system state, or escape the intended workspace entirely.

### Is the Virtual Filesystem Part of the Sandbox?

**Yes — it is the file layer of the sandbox.**

The sandbox is not a single thing. It is two layers that together cover the two categories of tools an agent uses:

| Layer | Covers | Tool | Status |
|---|---|---|---|
| **Virtual Filesystem** | File tool calls | `FilesystemBackend { virtualMode: true }` | ✅ Implemented |
| **Executor Sidecar** | Bash tool calls | HTTP executor container, no credentials | ✅ Implemented |

Together these form a complete sandbox:

```
Agent container
├── read_file("/TASK.md")      → Virtual FS intercepts → scoped to jobDir   ✅
├── write_file("/src/main.ts") → Virtual FS intercepts → scoped to jobDir   ✅
├── bash("npm test")           → Executor sidecar → isolated container       ✅
└── bash("cat /proc/self/env") → Executor sidecar → no credentials there     ✅
```

Neither layer alone is sufficient:
- **Virtual FS alone**: file operations are safe, but bash bypasses it entirely
- **Executor sidecar alone**: bash is sandboxed, but file tools still need path scoping

They solve different problems and are both required.

### The Shared Volume Connects Them

Both layers operate on the same files via a shared volume:

```
Shared Volume: /workspace/jobs/job-xxx/
       │
  ┌────┴────┐
  │         │
Agent    Executor
writes   executes
files    commands
  │         │
  └────┬────┘
       │
   Same repo files
```

The agent writes code via file tools → the sidecar runs `npm test` on those same files → the agent reads the results. No copying, no syncing. See [`shared-volume-bridge.md`](shared-volume-bridge.md) for the full breakdown.

---

## The Core Problem: Agents Are Autonomous and Unpredictable

When an agent like `DeepDevAgent` runs, it needs to **read, write, create, and delete files** and **execute shell commands** as part of doing its job. The question is: *what boundaries does it operate within?*

An LLM agent doesn't execute a fixed script. It *reasons* about what to do next, and its next action could be anything the model decides is appropriate — including:

- `rm -rf /` thinking it's cleaning up the workspace
- Writing to `/etc/hosts` or modifying system files
- Reading `/proc/self/environ` to leak secrets
- Overwriting files outside the intended workspace (e.g. `../../.aws/credentials`)
- Stealing IAM credentials from the ECS metadata endpoint

A sandbox creates a **hermetically sealed boundary** around the agent — it can do its job, but nothing it does can escape the defined scope.

---

## Layer 1: The Virtual Filesystem Sandbox (File Tools)

### What It Does

A virtual filesystem creates a scoped, controlled boundary for all **file tool calls**. The agent believes it's operating on a real filesystem rooted at `/`, but every path is transparently translated to a safe, scoped location on disk.

```typescript
// dev-agent.ts
backend: new FilesystemBackend({ rootDir: jobDir, virtualMode: true }),
```

- Agent calls `read_file("/TASK.md")` → reads `{jobDir}/TASK.md` ✅
- Agent calls `write_file("/src/index.ts", ...)` → writes `{jobDir}/src/index.ts` ✅
- Agent calls `read_file("../../.aws/credentials")` → blocked, clamped to `jobDir` ✅

### What It Protects Against

#### 🔑 Credential Theft via File Access
```bash
cat ../../.aws/credentials      # walks up out of jobDir — blocked ✅
cat /home/agent/.aws/config     # absolute path outside jobDir — blocked ✅
```

#### 💥 Path Traversal Escaping the Workspace
```typescript
// Agent calls write_file("../../secrets.env")
// Without virtual FS: resolves to /app/secrets.env — outside workspace!
// With virtual FS: clamped to {jobDir}/secrets.env ✅
```

#### 🕵️ Cross-Job Data Leakage
Without path scoping, `ls /workspace/` lists ALL job directories. With virtual FS, the agent can only see its own `jobDir`.

#### 🔄 State Pollution Between Jobs
Each job gets a fresh, unique timestamped `jobDir`. No leftover `TASK.md` or `REVIEW.json` from a prior job.

### Current Status

| Protection | Status |
|---|---|
| `FilesystemBackend { virtualMode: true }` | ✅ In place |
| Agent prompt uses only virtual paths (`/TASK.md`, not real `jobDir`) | ✅ Fixed |
| Each job gets a unique timestamped `jobDir` | ✅ In place |

---

## Layer 2: The Executor Sidecar Sandbox (Bash Tool)

### Why Bash Is a Different Problem

The virtual filesystem only governs the SDK's built-in file tools. The moment the agent uses the `bash` tool, it bypasses the virtual FS entirely:

```
Agent reads a file:
  read_file("/TASK.md")
      → FilesystemBackend intercepts → safe ✅

Agent runs bash:
  bash("cat /proc/self/environ")
      → execAsync() runs in container directly
      → no interception, no FS sandbox ❌
      → dumps AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
```

The bash guard (`checkBashGuard`) is a **denylist** — it blocks known-bad patterns. But LLMs are creative:

```bash
# None of these hit a typical denylist:
python3 -c "import os; print(os.environ)"
node -e "console.log(process.env)"
wget -qO- http://169.254.170.2/v2/credentials/...
```

### The Solution: Executor Sidecar

All bash commands are routed to a **dedicated, isolated container** over HTTP. The sidecar:
- Has **no AWS credentials** injected — no `AWS_ACCESS_KEY_ID`, no `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`
- Has **no GitHub token**
- Contains only developer tools: `node`, `npm`, `git`, `python3`
- Executes with `cwd` clamped to the shared `WORKSPACE_ROOT`

```
Agent: bash("cat /proc/self/environ")
    → POST http://executor:8080/exec { command, cwd }
    → Executor runs it — but its /proc/self/environ has NO AWS secrets ✅
    → Returns (empty or irrelevant output)

Agent: bash("npm test")
    → POST http://executor:8080/exec { command, cwd: "/workspace/jobs/job-xxx/" }
    → Executor runs npm test on the shared volume files ✅
    → Returns { stdout, stderr, exitCode }
```

### How the Routing Works in Code

```typescript
// dev-agent.ts — makeBashTool
if (EXECUTOR_URL) {
    // Docker / ECS: route through isolated sidecar
    return runViaExecutor(command, cwd, timeout);
} else {
    // Local dev without Docker: run directly (no sidecar running)
    return runLocally(command, cwd, timeout);
}
```

`EXECUTOR_URL` is set by the Docker Compose / ECS task definition. When absent, the tool falls back to direct execution — so `npm run dev` still works without Docker.

### Current Status

| Protection | Status |
|---|---|
| Executor sidecar service (`deploy/executor/server.ts`) | ✅ Implemented |
| `makeBashTool` routes via HTTP when `EXECUTOR_URL` is set | ✅ Implemented |
| Sidecar has no AWS credentials injected | ✅ By design (docker-compose + task definition) |
| Sidecar `cwd` clamped to `WORKSPACE_ROOT` | ✅ Enforced in `server.ts` |
| Fallback to local exec when `EXECUTOR_URL` absent | ✅ Works for `npm run dev` |

---

## Part 3: Why 1 ECS Task per Job Helps (But Isn't Enough Alone)

Your architecture of 1 Fargate task per job provides **container-level** isolation:

- Agent jobs don't share kernel with other customers ✅
- Each task has its own network namespace ✅
- The task dies when the job ends, limiting exposure window ✅

**But without the sandbox layers, the agent still has full container identity:**

| Concern | ECS Task | Virtual FS | Executor Sidecar |
|---|---|---|---|
| Cross-job FS leakage | ❌ | ✅ Scoped paths | N/A |
| Path traversal escaping `jobDir` | ❌ | ✅ Blocked | N/A |
| IMDS credential theft | ❌ | ❌ Bash bypasses FS | ✅ No creds in sidecar |
| Env var leakage (`env`, `printenv`) | ❌ | ❌ Bash bypasses FS | ✅ No creds in sidecar |
| Arbitrary network calls | ❌ | ❌ Bash bypasses FS | ⚠️ Sidecar shares network ns* |
| Between-job state pollution | ❌ | ✅ Fresh `jobDir` | N/A |

> **\* Shared network namespace:** In ECS Fargate, all containers in a task share the same network namespace, so the sidecar can technically reach `169.254.170.2`. However, `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` is not injected into the sidecar, so it doesn't know the credential path. Mitigate further with a VPC NACL blocking IMDS egress (see `deploy/fargate/iam-policies.yml`).

---

## Current Complete Architecture

```
ECS Fargate Task (1 per agent job)
┌──────────────────────────────────────────────────────┐
│                                                      │
│  Agent Container              Executor Sidecar       │
│  ─────────────────            ──────────────────     │
│  • LLM reasoning              • Runs bash cmds       │
│  • File tools (via VFS)       • No AWS creds         │
│  • AWS creds ✅               • AWS creds ❌          │
│  • setupWorkspace()           • No GitHub token      │
│  • pushAndTeardown()                                 │
│                                                      │
│  read_file("/TASK.md")                               │
│    → VFS → {jobDir}/TASK.md ✅                       │
│                                                      │
│  bash("npm test")                                    │
│    → POST executor/exec ──────────────────►          │
│    ← { stdout, stderr } ◄──────────────────          │
│                                                      │
│         Shared Volume: /workspace/jobs/job-xxx/      │
│         ─────────────────────────────────────        │
│         (agent writes files, executor executes them) │
└──────────────────────────────────────────────────────┘
```

---

## Recommendation

| Step | Action | Priority |
|---|---|---|
| ✅ Done | Virtual FS (`FilesystemBackend virtualMode: true`) | Critical |
| ✅ Done | Virtual paths in agent prompt (no real `jobDir` exposed) | Important |
| ✅ Done | Executor sidecar + `makeBashTool` HTTP routing | Critical |
| ✅ Done | Docker Compose for local testing | Done |
| ✅ Done | ECS task definition with sidecar container | Done |
| 🔧 Next | Block IMDS (`169.254.170.2`) at VPC NACL level | High |
| 🔧 Next | Scope ECS task IAM role to minimum permissions | High |
| 🔮 Future | Lambda MicroVMs — if moving to multi-tenant / untrusted code | Optional upgrade |

**The sandbox is now two-layered and complete: the virtual FS covers file tools, the executor sidecar covers bash. Together they close the two attack surfaces an LLM agent has.**
