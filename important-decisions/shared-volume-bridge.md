# The Shared Volume Is the Bridge

## Summary

The agent container and the executor sidecar are two separate, isolated containers. They communicate over HTTP for command execution — but the files they operate on live in a **single shared volume** mounted into both containers at the same path (`/workspace/jobs`).

This means:
- The agent container clones the repo and writes files → they appear in the sidecar instantly
- The sidecar runs `npm install`, `git commit`, etc. → the results are visible to the agent immediately
- No file copying. No syncing. Same real disk blocks, accessed by both.

---

## How It Works

### The Setup Sequence

```
1. setupWorkspace() — runs in AGENT container
   │
   ├─ gitClone(remoteUrl, { targetDir: "/workspace/jobs/job-PROJ-1-1234/" })
   │    → writes entire repo to shared volume
   │
   ├─ fs.writeFile("/workspace/jobs/job-PROJ-1-1234/TASK.md", ...)
   │    → writes task spec to shared volume
   │
   └─ fs.writeFile("/workspace/jobs/job-PROJ-1-1234/CLAUDE.md", ...)
        → writes operational guidelines to shared volume

2. DeepDevAgent.run() — agent loop begins in AGENT container     
   │
   ├─ FilesystemBackend reads "/TASK.md"
   │    → translates to /workspace/jobs/job-PROJ-1-1234/TASK.md
   │    → reads from shared volume ✅
   │
   ├─ Agent edits "/src/index.ts" via write_file
   │    → writes to /workspace/jobs/job-PROJ-1-1234/src/index.ts
   │    → on the shared volume ✅
   │
   └─ Agent calls bash("npm test")
        → POST http://executor:8080/exec
           { command: "npm test",
             cwd: "/workspace/jobs/job-PROJ-1-1234/" }
        → Executor runs "npm test" in that directory
        → On the SAME shared volume — sees all edits the agent made ✅

3. pushAndTeardown() — runs in AGENT container
   │
   └─ gitPush(branch, "/workspace/jobs/job-PROJ-1-1234/")
        → git reads .git/ from shared volume
        → includes all commits made by the executor sidecar ✅
```

---

## Why gitClone Stays in the Agent Container (Not the Executor)

The executor sidecar has **no credentials** by design. Git clone over HTTPS requires a `GITHUB_TOKEN` to authenticate with private repositories. Routing clone through the executor would break it.

Instead: the agent container (which holds the token) clones into the shared volume. The executor then operates on the already-cloned files — it never needs to contact GitHub directly.

| Operation | Runs In | Needs Credentials | Volume Access |
|---|---|---|---|
| `gitClone` | Agent container | ✅ GITHUB_TOKEN | Writes to volume |
| `gitConfig` | Agent container | No | Writes to volume |
| `fs.writeFile` (TASK.md) | Agent container | No | Writes to volume |
| `npm install` (bash tool) | Executor sidecar | No | Reads/writes volume |
| `npm test` (bash tool) | Executor sidecar | No | Reads volume |
| `git commit` (bash tool) | Executor sidecar | No | Reads/writes volume |
| `gitPush` (teardown) | Agent container | ✅ GITHUB_TOKEN | Reads from volume |

---

## Volume Mechanics

### Docker Compose (Local Dev)

```yaml
volumes:
  jobs:            # Docker creates a named volume on the host
    driver: local

services:
  agent:
    volumes:
      - jobs:/workspace/jobs    # agent mounts it here

  executor:
    volumes:
      - jobs:/workspace/jobs    # executor mounts the SAME named volume
```

Both containers are mapped to the same directory on the Docker host:

```
Docker Host Disk
  /var/lib/docker/volumes/<project>_jobs/_data/
                    │
           ┌────────┴────────┐
           │                 │
    Agent container   Executor sidecar
    /workspace/jobs/  /workspace/jobs/
    (writes files)    (executes in them)
```

Same inode. Same disk blocks. Writes from one container are visible to the other with **zero latency** — there is no copy, no sync, no network transfer.

### ECS Fargate (Production)

```json
"volumes": [{ "name": "jobs", "host": {} }]
```

`"host": {}` tells Fargate to allocate a temporary directory on the underlying host VM and bind-mount it into both containers. AWS manages the host VM — you never interact with it directly.

```
Fargate Host VM (ephemeral, AWS-managed)
  /var/lib/ecs/volumes/<task-id>/jobs/
                    │
           ┌────────┴────────┐
           │                 │
    Agent container   Executor sidecar
    /workspace/jobs/  /workspace/jobs/
```

The volume exists for the lifetime of the task and is automatically destroyed when the task stops.

### Comparison

| Property | Docker Compose | ECS Fargate |
|---|---|---|
| Volume type | Named volume | ECS bind mount (`host: {}`) |
| Backed by | Docker volume driver (local SSD) | Fargate task host disk (ephemeral SSD) |
| Shared between containers | ✅ Yes — same inode | ✅ Yes — same inode |
| Survives container restart | ✅ Yes | ✅ Yes (within the task) |
| Survives task/compose stop | ✅ Yes (named volume persists) | ❌ No — destroyed with the task |
| Cross-container read latency | ~0 — same disk | ~0 — same disk |
| Data isolation between tasks | ✅ Each task gets its own volume | ✅ Each task gets its own volume |

---

## The Credential Boundary

The shared volume carries **files only** — not credentials. Each container's environment variables are completely separate:

```
Agent Container env:                  Executor Sidecar env:
  ANTHROPIC_API_KEY = sk-ant-...        (not set)
  GITHUB_TOKEN = ghp_...               (not set)
  AWS_CONTAINER_CREDENTIALS_URI = ...  (not set)
  EXECUTOR_URL = http://executor:8080  EXECUTOR_PORT = 8080
  JOBS_DIR = /workspace/jobs           WORKSPACE_ROOT = /workspace/jobs
```

The executor can read and write files on the shared volume — but it cannot read the agent's environment variables, and it has no path to AWS or GitHub credentials. This is the isolation boundary the sidecar pattern provides.

---

## Visual Summary

```
┌─────────────────────────────────────────────────────────────────┐
│  ECS Fargate Task  /  Docker Compose                            │
│                                                                 │
│  ┌─────────────────────────┐     ┌────────────────────────────┐ │
│  │    Agent Container      │     │    Executor Sidecar        │ │
│  │                         │     │                            │ │
│  │  AWS creds ✅           │     │  AWS creds ❌              │ │
│  │  GitHub token ✅        │     │  GitHub token ❌           │ │
│  │                         │     │                            │ │
│  │  setupWorkspace()       │     │  POST /exec received       │ │
│  │   └─ gitClone ──────────┼──┐  │   └─ execAsync(cmd, cwd)  │ │
│  │   └─ write TASK.md ─────┼──┤  │       in /workspace/jobs/ │ │
│  │                         │  │  │                            │ │
│  │  agent reads /TASK.md ──┼──┤  │                            │ │
│  │  agent bash("npm test") │  │  │                            │ │
│  │   └─ POST /exec ────────┼──┼──►                            │ │
│  │   ◄── { stdout } ───────┼──┼──┘                            │ │
│  │                         │  │                               │ │
│  │  pushAndTeardown() ─────┼──┘                               │ │
│  │   └─ gitPush ───────────┼──┐  (reads commits made          │ │
│  │                         │  └─── by executor) ✅            │ │
│  └─────────────────────────┘     └────────────────────────────┘ │
│                                                                 │
│              Shared Volume: /workspace/jobs/                    │
│              ─────────────────────────────                      │
│              job-PROJ-1-1234/                                   │
│                ├── src/           ← agent writes via FS tools   │
│                ├── package.json   ← executor reads for npm      │
│                ├── TASK.md        ← agent reads via FS tools    │
│                ├── CLAUDE.md                                    │
│                └── .git/          ← executor commits here       │
└─────────────────────────────────────────────────────────────────┘
```
