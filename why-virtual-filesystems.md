# Why AI Agents Need a Virtual Filesystem

## The Core Problem: Agents Are Autonomous and Unpredictable

When an agent like `DeepDevAgent` runs, it needs to **read, write, create, and delete files** as part of doing its job (editing code, writing tests, reading configs, etc.). The question is: *which filesystem does it operate on?*

An LLM agent doesn't execute a fixed script. It *reasons* about what to do next, and its next action could be anything the model decides is appropriate — including:

- `rm -rf /` thinking it's cleaning up the workspace
- Writing to `/etc/hosts` or modifying system files
- Accidentally reading `/proc/self/environ` (leaking secrets)
- Overwriting files outside the intended workspace (e.g. `../../.aws/credentials`)

A virtual filesystem creates a **hermetically sealed boundary** — the agent *believes* it's operating on a real filesystem at `/`, but every path is transparently translated to a scoped, controlled location.

---

## Harmful Scenarios Without a Virtual Filesystem

### 1. 🔑 Credential Theft

Your agent runs on ECS Fargate. The ECS task role credentials are available at the metadata endpoint:

```
http://169.254.170.2/v2/credentials/<uuid>
```

And injected as environment variables:

```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Without a virtual FS, the agent can do:

```bash
cat /proc/self/environ       # dumps all env vars, including AWS creds
curl http://169.254.170.2/v2/credentials/...   # steals IAM role token
```

The agent could then use those credentials to call any AWS API (S3, Lambda, DynamoDB, etc.) with your task role's permissions. This is a **real attack surface** — the agent isn't malicious, but the *model's tool calls are strings* and a poorly-worded task can cause exactly this.

---

### 2. 💥 Filesystem Escaping the Workspace

Your `jobDir` might be `/app/jobs/abc-123/`. Without path containment:

```typescript
// Agent calls write_file with path: "../../secrets.env"
// Resolves to: /app/secrets.env  ← outside workspace!
```

Or worse, path traversal that reaches host-mounted volumes in a Fargate task, like EFS mounts shared across tasks.

---

### 3. 🧨 Destroying System State

The agent might legitimately need to run `npm install` or `git clean -fd`, but without a virtual FS, a confused `bash` call like:

```bash
rm -rf /tmp && mkdir /tmp    # meant to clear temp files
# but /tmp is shared with the OS
```

…can break the container's runtime. A bash guard (`checkBashGuard`) helps, but it's a denylist — it can't anticipate every variant.

---

### 4. 🕵️ Cross-Job Data Leakage (Multi-tenant Risk)

If you run multiple agent jobs concurrently on the same ECS task (or share a volume across tasks), without a virtual FS, **Job A can read Job B's files**. A path like `/workspace/` without strict isolation means:

```bash
ls /workspace/    # might list ALL job directories, not just this job's
```

This is especially dangerous if stories contain customer data, API keys checked into the repo, etc.

---

### 5. 🔄 Non-Deterministic State Pollution

When an agent job ends and the next starts, leftover files from the previous run contaminate the new run's reasoning. The agent reads a stale `TASK.md` or `REVIEW.json` from a prior job and makes decisions based on it.

---

## Why ECS Fargate Alone Is NOT Sufficient Isolation

You might think: *"I'm running each job in its own Fargate task — isn't that isolated enough?"*

**Partially, yes. But there are gaps:**

| Concern | ECS Fargate Task | Virtual FS |
|---|---|---|
| Isolation between *concurrent jobs in the same task* | ❌ Shared | ✅ Each job scoped |
| Path traversal escaping `jobDir` | ❌ No guard | ✅ Enforced |
| Access to `/proc`, `/etc`, metadata endpoint | ❌ Accessible | ✅ Hidden |
| Environment variable leakage | ❌ All envs visible | ✅ Agent sees only what's injected |
| Symlink attacks (`../../` tricks) | ❌ No guard | ✅ Canonicalized |
| Between-job state pollution | ❌ Shared disk unless cleaned | ✅ Clean by design |

Fargate gives you **container-level** isolation (you don't share a kernel with other *customers*). But the agent still runs **inside** that container and has full access to everything inside it — the credentials, the filesystem, the network metadata endpoint.

---

## What the Current `FilesystemBackend` in `dev-agent.ts` Does

```typescript
backend: new FilesystemBackend({ rootDir: jobDir, virtualMode: true }),
```

`virtualMode: true` means:

- All agent paths like `/src/index.ts` → `{jobDir}/src/index.ts`
- Path traversal attempts like `../../evil` → blocked/clamped to `jobDir`
- The agent *thinks* it has a root filesystem, but it's sandboxed to `jobDir`

This is the **minimum viable protection** that already defends against scenarios 2, 4, and 5 above.

---

## Why Lambda MicroVMs Add a Deeper Layer

The `FilesystemBackend` protects the FS but the agent's **bash tool** still runs inside the Fargate container and can:

- Hit the IMDS metadata endpoint
- Read `/proc/self/environ`
- Make arbitrary network calls

Lambda MicroVMs add a **second, deeper layer**: the bash tool and all code execution happens *inside the MicroVM* — a fully separate kernel, no access to the host's network stack, no IMDS, no shared memory. Even if the agent's bash tool goes rogue, it's contained within a disposable VM that gets terminated when the job ends.

> **Key property from AWS docs:**
> *"Lambda MicroVMs provides a separate execution boundary per task: an isolated compute environment with no access to agent state and no shared state across users."*
> — [AWS Lambda MicroVMs](https://aws.amazon.com/lambda/lambda-microvms/)

---

## Recommendation for an ECS Fargate Setup

| Layer | What It Protects | Already in Place? |
|---|---|---|
| `FilesystemBackend { virtualMode: true }` | FS path traversal, cross-job leakage, state pollution | ✅ Yes |
| Bash guard (`checkBashGuard`) | Dangerous shell commands | ✅ Yes |
| Scoped ECS task IAM role | Over-privileged AWS API access | 🔧 Must be configured |
| Block IMDS from container network | Credential theft via metadata endpoint | 🔧 Optional hardening |
| **Lambda MicroVMs** | Full kernel isolation, bash tool containment | 🔮 Next-level upgrade |

**Bottom line for a single-tenant per-task Fargate setup:**
The current `FilesystemBackend` already handles the most critical FS attack vectors. Lambda MicroVMs are the right next step if you run untrusted or AI-generated code at scale and need VM-level bash containment — not just FS-level sandboxing.
