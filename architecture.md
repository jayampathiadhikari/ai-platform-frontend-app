# Agent Architecture: Orchestrator vs Agent Separation

## The Core Problem

The agent needs an **isolated, writable filesystem** (its workspace) to:
- Read the codebase
- Create/edit files
- Run commands

The workspace must exist *before* the agent starts work. The question is: **who creates it, and where does it live?**

---

## Option A — Single Instance (Monolith)

```
┌─────────────────────────────────────────┐
│             Node.js Process             │
│                                         │
│  POST /run ──► Orchestrator             │
│                    │                    │
│                    ▼                    │
│             Creates workspace           │
│             (local tempdir)             │
│                    │                    │
│                    ▼                    │
│            Runs agent inline            │
│          (same event loop / thread)     │
└─────────────────────────────────────────┘
```

**Pros**
- Simple to build and debug
- No network boundary between orchestrator and agent
- Workspace is just a local path

**Cons**
- One long-running agent **blocks** the event loop (or you need worker threads)
- Can't scale agents independently
- A crashing agent can take down the orchestrator
- Workspace lives on the same disk as the server — disk contention under load

> Best for: **prototyping and local dev only**

---

## Option B — Separate Processes (Recommended)

```
┌────────────────────┐         ┌───────────────────────────┐
│    Orchestrator    │         │       Agent Worker         │
│   (HTTP Server)    │         │   (spawned per job)        │
│                    │  spawn  │                            │
│  POST /run ───────►│────────►│  1. Receive job context    │
│                    │         │  2. git clone → checkout   │
│  Tracks job state  │         │  3. git create-branch      │
│  Returns job ID    │         │  4. Run agent (SDK)        │
│                    │         │  5. Exit / report result   │
└────────────────────┘         └───────────────────────────┘
```

### Key Design Decision: Who prepares the workspace?

**Let the Agent Worker set up its own workspace.**

The orchestrator only:
- Resolves the ticket
- Parses the `@agent` directive
- Generates a `jobId`
- Spawns the worker with a JSON job context

The agent worker starts, receives `{ jiraId, jobId, repoUrl, checkoutBranch, workDir }` and does:
```
git clone <repoUrl> <workDir>
git checkout <checkoutBranch>        ← base branch
git checkout -b agent/<jobId>        ← new working branch
```

This way **no shared filesystem** is needed between orchestrator and agent.

---

## Deployment Models

### Local / Dev — `child_process.spawn`

```
Orchestrator spawns agent as a child process.
workDir = os.tmpdir()/ai-agent-workspaces/<jobId>
```

```ts
// orchestrator dispatches like this:
spawn("node", ["dist/agent-worker.js"], {
  env: { ...process.env, JOB_CONTEXT: JSON.stringify(ctx) }
});
```

### Staging / Production — Docker container per job

```
Orchestrator calls Docker API (or Kubernetes Job API):
  docker run --rm \
    -e JOB_CONTEXT='{"jiraId":"PROJ-104","repoUrl":"...","branch":"..."}' \
    your-agent-image:latest
```

Each container:
- Has its own isolated filesystem (no shared volume needed)
- Clones the repo fresh inside the container
- Exits when done

### Scale-out — Job Queue (SQS / BullMQ / etc.)

```
POST /run ──► Orchestrator enqueues job ──► Queue
                                              │
                                    ┌─────────┴──────────┐
                              Worker A              Worker B
                           (container/pod)      (container/pod)
```

Workers poll the queue, pick up jobs, do their own git setup, run the agent.

---

## Recommended Architecture (for this project)

```
src/
├── index.ts                  ← Express server (Orchestrator)
│     POST /run               ← accepts { jiraId }
│     POST /jobs/:id/status   ← poll job status
│
├── orchestrator/
│   └── orchestrator.ts       ← resolveTicket() + dispatch()
│
├── agent-worker.ts           ← standalone entry point
│     reads JOB_CONTEXT env   ← git setup → run agent → exit
│
├── git/
│   └── git.ts                ← gitClone, gitCheckout, gitCreateAndCheckout
│
└── context-provider/
    └── mock-jira-tickets.ts
```

### Flow

```
POST /run { jiraId: "PROJ-104" }
  │
  ├─ orchestrator.resolveTicket(jiraId)  → ticket + directive
  ├─ generate jobId
  ├─ spawn agent-worker (child_process or Docker)
  │    env: JOB_CONTEXT = { jobId, jiraId, repoUrl, checkoutBranch, workDir }
  │
  └─ return { jobId }  ← immediately (non-blocking)

agent-worker boots:
  ├─ parse JOB_CONTEXT
  ├─ gitClone(repoUrl, { targetDir: workDir })
  ├─ gitCheckout(checkoutBranch, workDir)
  ├─ gitCreateAndCheckout(`agent/${jobId}`, workDir)
  └─ run Claude agent SDK with workDir as CWD
```

---

## Summary

| Concern | Answer |
|---|---|
| Same instance or separate? | **Separate** — agent worker is its own process/container |
| Who creates the workspace? | **The agent worker** — it clones the repo itself |
| Shared filesystem needed? | **No** — each worker is self-contained |
| How to pass context? | **`JOB_CONTEXT` env var** (JSON) |
| Local dev | `child_process.spawn` |
| Production | `docker run` per job, or Kubernetes Job |
| Scale-out | Job queue (BullMQ / SQS) between orchestrator and workers |
