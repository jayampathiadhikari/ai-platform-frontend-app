# Sandbox Approach: Sidecar Executor Container

## Decision

We will use an **ECS sidecar container** to provide bash isolation for the `DeepDevAgent`, instead of AWS Lambda MicroVMs.

All bash commands issued by the agent are routed to a dedicated, minimal executor container running in the same ECS Fargate task over localhost HTTP. The agent container retains IAM credentials; the executor container has none.

---

## Context

The `DeepDevAgent` operates with two categories of tools:

- **File tools** (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`) — already sandboxed by `FilesystemBackend { virtualMode: true }`, scoped to the job's `jobDir`
- **Bash tool** (`bash`) — currently executes directly inside the agent container via `execAsync`, with only a denylist-based guard (`checkBashGuard`)

The bash tool is the primary security gap. It runs with the full identity of the agent container — including access to AWS environment variables, the ECS credential endpoint (`169.254.170.2`), and the host process namespace. A single creative LLM output (e.g. `python3 -c "import os; print(os.environ)"`) bypasses the denylist entirely.

---

## Why Not Lambda MicroVMs

AWS Lambda MicroVMs would provide the strongest possible isolation — a separate Firecracker VM per job with a completely isolated kernel, network namespace, and no access to the host IMDS endpoint. However:

| Concern | Detail |
|---|---|
| **Operational complexity** | Requires building and maintaining a MicroVM guest image (Dockerfile + HTTP filesystem server inside the VM) |
| **New AWS service dependency** | Lambda MicroVMs is a new service with limited SDK support and evolving API surface |
| **Cost model change** | Per-second MicroVM billing on top of ECS Fargate costs |
| **Cold-start risk** | Even with snapshot-based resume, MicroVM provisioning adds latency to agent startup |
| **Overkill for current threat model** | We run internal team agents, not multi-tenant or user-submitted arbitrary code |

Lambda MicroVMs are the right answer for a **multi-tenant, public-facing** agent platform where the code being executed is fully untrusted. That is not our current architecture.

---

## Why the Sidecar Pattern

The sidecar approach achieves the critical goals with a fraction of the complexity:

### What it gives us

| Protection | How |
|---|---|
| **Env var isolation** | Sidecar container has no `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` injected — agent creds are invisible to it |
| **Process isolation** | Bash runs in a separate container PID namespace — a rogue process cannot signal or inspect the agent process |
| **Minimal attack surface** | Sidecar image contains only `node`, `npm`, `git`, `python3` — no AWS CLI, no credential helpers, no secrets |
| **Resource isolation** | Separate CPU/memory limits per container in the task definition |
| **Clean architectural boundary** | Agent reasons; executor executes. Responsibilities are separated |

### What it does NOT give us (known limitations)

| Limitation | Detail |
|---|---|
| **Shared network namespace** | ECS Fargate containers in the same task share a network namespace — the sidecar can technically reach `169.254.170.2`. Mitigated by not injecting the credential URI env var into the sidecar. |
| **Not a hard VM boundary** | Container isolation is Linux namespace-based, not hypervisor-based. A kernel exploit could theoretically cross containers. Acceptable for our threat model. |

---

## Architecture

```
ECS Fargate Task (1 per agent job)
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  ┌──────────────────────────┐        ┌───────────────────┐  │
│  │     Agent Container      │        │  Executor Sidecar │  │
│  │   (dev-agent.ts)         │        │  (bash-executor)  │  │
│  │                          │        │                   │  │
│  │  • Runs LLM agent loop   │        │  • Tiny HTTP API  │  │
│  │  • Holds AWS IAM role    │  HTTP  │  • POST /exec     │  │
│  │  • Has AWS env vars      │ :8080  │  • No IAM role    │  │
│  │  • Virtual FS (jobDir)   │ ──────►│  • No AWS creds   │  │
│  │                          │◄────── │  • node/npm/git   │  │
│  │  bash("npm test")        │        │    only           │  │
│  │    → POST /exec          │        │                   │  │
│  │    ← { stdout, stderr }  │        │                   │  │
│  └──────────────────────────┘        └───────────────────┘  │
│                                                             │
│            Shared ephemeral volume (/workspace/jobs/...)    │
│               Agent writes files → Sidecar executes them   │
└─────────────────────────────────────────────────────────────┘
```

---

## Code Change Summary

### `dev-agent.ts` — `makeBashTool`

The bash tool is updated to `POST` to the sidecar instead of calling `execAsync` directly:

```typescript
// Before — executes in agent container
const { stdout, stderr } = await execAsync(command, { cwd: jobDir });

// After — delegates to executor sidecar
const res = await fetch("http://localhost:8080/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, cwd: "/workspace" }),
});
const { stdout, stderr } = await res.json();
```

### New: `executor/` directory

A minimal HTTP server (Node.js) that:
- Listens on `:8080`
- Accepts `POST /exec { command: string, cwd: string }`
- Runs the command via `execAsync` scoped to the shared volume path
- Returns `{ stdout, stderr, exitCode }`
- Has its own `Dockerfile` — built from a minimal base image with only required dev tools

### ECS Task Definition

The sidecar container is added alongside the agent container:
- Mounts the same shared ephemeral volume as the agent
- No `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` env var
- No task role assignment at the container level
- Health check: `GET /health` → `200 OK`

---

## Migration Path to Lambda MicroVMs

If the threat model changes (e.g. we move to multi-tenant, public-facing use), migrating from this pattern to Lambda MicroVMs is straightforward:

1. Replace the `fetch("http://localhost:8080/exec", ...)` call in `makeBashTool` with a call to the MicroVM HTTPS endpoint
2. Replace the sidecar `Dockerfile` with a MicroVM guest image
3. Add MicroVM provisioning/teardown in `DeepDevAgent.run()`

The interface contract (`command → stdout/stderr`) stays identical. The transport and isolation level are the only things that change.

---

## Status

- [x] Decision made
- [ ] `executor/` sidecar service implemented
- [ ] `makeBashTool` updated to route to sidecar
- [ ] ECS Task Definition updated with sidecar container
- [ ] Sidecar `Dockerfile` written and image built
- [ ] End-to-end tested on a real agent job
