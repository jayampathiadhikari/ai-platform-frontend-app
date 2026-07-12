# Why AI Agents Need Sandboxes

## Summary

AI agents like `DeepDevAgent` execute autonomously — they read files, write code, and run shell commands without human approval at each step. Without a sandbox, a single bad tool call can leak cloud credentials, destroy system state, or escape the intended workspace entirely.

This codebase uses **two layers of protection**, with a known gap in the second:

| Layer | Tool | Status |
|---|---|---|
| **Virtual Filesystem** | `FilesystemBackend { virtualMode: true }` | ✅ Solid — file ops fully scoped to `jobDir` |
| **Bash guard** | `checkBashGuard` (denylist) | ⚠️ Porous — bypassed by creative LLM outputs |

**The virtual FS is the right foundation.** It prevents all file-based escapes. The remaining gap is the `bash` tool — it executes directly inside the ECS container, bypassing the FS boundary entirely. This means the agent can still reach the AWS IMDS credential endpoint, dump environment variables, or make arbitrary network calls via Python/Node one-liners not covered by the denylist.

**For the current 1-task-per-job ECS Fargate architecture**, the immediate mitigations are:
1. Lock down the ECS task IAM role to minimum required permissions
2. Block `169.254.170.2` (IMDS) at the security group level

**Lambda MicroVMs** are the long-term answer for true bash isolation — each agent job runs in a separate Firecracker VM with no access to the host network, IMDS, or environment.

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

## Part 1: The Virtual Filesystem Sandbox

### What It Does

A virtual filesystem creates a scoped, controlled boundary for all **file operations**. The agent believes it's operating on a real filesystem rooted at `/`, but every path is transparently translated to a safe, scoped location on disk.

```typescript
// dev-agent.ts
backend: new FilesystemBackend({ rootDir: jobDir, virtualMode: true }),
```

- Agent calls `read_file("/TASK.md")` → reads `{jobDir}/TASK.md` ✅
- Agent calls `write_file("/src/index.ts", ...)` → writes `{jobDir}/src/index.ts` ✅
- Agent calls `read_file("../../.aws/credentials")` → blocked, clamped to `jobDir` ✅

### Harmful Scenarios Without a Virtual Filesystem

#### 🔑 Credential Theft via File Access

```bash
cat ../../.aws/credentials      # walks up out of jobDir
cat /home/agent/.aws/config     # reads real host credentials
```

#### 💥 Filesystem Escaping the Workspace

```typescript
// Agent calls write_file with path: "../../secrets.env"
// Without virtual FS: resolves to /app/secrets.env  ← outside workspace!
```

#### 🧨 Destroying System State

```bash
rm -rf /tmp     # /tmp is shared with the OS process
```

#### 🕵️ Cross-Job Data Leakage (Multi-tenant)

Without path scoping, `ls /workspace/` lists ALL job directories — Job A reads Job B's files, credentials, or task specs.

#### 🔄 Non-Deterministic State Pollution

Without a fresh scoped directory per job, leftover `TASK.md` or `REVIEW.json` from a prior job contaminates the next agent's reasoning.

### Current Status in This Codebase

| Protection | Status |
|---|---|
| Virtual FS (`FilesystemBackend virtualMode: true`) | ✅ In place |
| Agent prompt uses only virtual paths (`/TASK.md`) | ✅ Fixed — real `jobDir` no longer exposed |
| Each job gets a unique timestamped `jobDir` | ✅ In place |
| Agent's bash `cwd` scoped to `jobDir` | ✅ In place |

---

## Part 2: The Bash Tool — The Real Gap ⚠️

### Why Bash Is Different

The virtual filesystem only governs the SDK's built-in file tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`). The moment the agent uses the `bash` tool, it bypasses the virtual FS entirely and executes **directly as the container process**:

```
Agent reads a file:
  read_file("/TASK.md")
      → FilesystemBackend intercepts
      → reads {jobDir}/TASK.md safely ✅

Agent runs bash:
  bash("cat /proc/self/environ")
      → execAsync() runs in container directly
      → no interception, no sandbox ❌
      → dumps AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, etc.
```

### What `checkBashGuard` Actually Covers

The current guard is a **denylist** of known-dangerous patterns (sudo, rm -rf /, curl|sh, force-push, etc.). But LLMs are creative — a confused or compromised agent can bypass it with:

```bash
# None of these are in a typical denylist:
python3 -c "import urllib.request; urllib.request.urlopen('http://169.254.170.2/v2/credentials/...')"
python3 -c "import os; print(os.environ)"
node -e "console.log(process.env)"
wget -qO- http://169.254.170.2/v2/credentials/$(cat /proc/self/cgroup)
```

A dev agent **legitimately needs** `npm`, `git`, `node`, `python`, `curl` (for API tests) — so an allowlist is nearly impossible without breaking real workflows.

### The Core Architectural Gap

```
ECS Fargate Container
│
├── Virtual FS boundary (FilesystemBackend)  ──── tight ✅
│     covers: read_file, write_file, glob, grep, ls
│     enforces: path scoping, traversal blocking
│
└── Bash tool boundary (checkBashGuard)      ──── porous ⚠️
      covers: a denylist of ~10 patterns
      exposes: IMDS endpoint, /proc, all env vars, full network stack
```

The two tools the agent uses most — **file tools** and **bash** — have wildly different isolation levels. The file boundary is solid; the bash boundary is a screen door.

---

## Part 3: Why 1 ECS Task per Job Helps (But Doesn't Fully Solve It)

Your architecture of 1 Fargate task per job already provides **container-level** isolation:

- Agent jobs don't share kernel with other customers ✅
- Each task has its own network namespace ✅
- The task dies when the job ends, limiting exposure window ✅

**But the agent still runs inside that container with full container identity:**

| Concern | ECS Fargate Task | Virtual FS | Bash Isolation |
|---|---|---|---|
| Cross-job FS leakage | ❌ Shared disk | ✅ Scoped paths | N/A |
| Path traversal escaping `jobDir` | ❌ | ✅ Blocked | N/A |
| IMDS credential theft | ❌ Accessible | ❌ Bypass via bash | ❌ Not blocked |
| Env var leakage (`env`, `printenv`) | ❌ | ❌ Bypass via bash | ❌ Not blocked |
| Arbitrary network calls | ❌ | ❌ Bypass via bash | ❌ Not blocked |
| Between-job state pollution | ❌ Shared disk | ✅ Fresh `jobDir` | N/A |

---

## Part 4: Options to Fix Bash Isolation

### Option 1: Lambda MicroVMs (Strongest — VM-level isolation)

Every bash command executes inside a fresh Firecracker MicroVM. The container process never runs agent code. IMDS, `/proc`, env vars — none reachable from inside the VM.

```
Agent: bash("curl 169.254.170.2/...")
    → sent to MicroVM HTTPS endpoint
    → MicroVM has no route to host IMDS
    → fails harmlessly, no credential leak
```

**Tradeoff:** Operational complexity, requires pre-built MicroVM image, new AWS service dependency.

### Option 2: Block IMDS at the Network Level (Practical Middle Ground)

Block `169.254.170.2` (the credential endpoint) at the ECS task security group level. Strip AWS credentials from env vars — use IAM Roles for Service Accounts or Secrets Manager SDK-level auth instead.

```json
// ECS Task security group: deny egress to 169.254.170.2/32
// ECS Task definition: do not inject AWS_ACCESS_KEY_ID as env var
```

**Tradeoff:** Closes the most critical vector (credential theft) but doesn't prevent all bash escapes.

### Option 3: Seccomp Profile (Kernel syscall filtering)

Run the Fargate task with a seccomp profile blocking dangerous syscalls. Fargate has limited seccomp support, and maintaining a profile is non-trivial.

### Option 4: Scoped Execution Tool (Architectural refactor)

Replace raw `execAsync` bash with a restricted runner — only `npm`, `git`, `node` are allowed by an allowlist; everything else returns `BLOCKED`. Harder to maintain as agent workflows grow.

---

## Recommendation

For this architecture (1 ECS task per job, internal team use, scoped IAM role):

| Step | Action | Priority |
|---|---|---|
| ✅ Done | Virtual FS (`FilesystemBackend virtualMode: true`) | Critical |
| ✅ Done | Virtual paths in agent prompt (no real `jobDir` exposed) | Important |
| 🔧 Next | Block IMDS at ECS security group level | High |
| 🔧 Next | Scope ECS task IAM role to minimum required permissions | High |
| 🔮 Future | Lambda MicroVMs for true bash isolation at scale | If running untrusted code / multi-tenant |

**The virtual FS is solid. Bash isolation is the remaining gap — and the severity depends entirely on how tightly scoped your ECS task IAM role is.**
