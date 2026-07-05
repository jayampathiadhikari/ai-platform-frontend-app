import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { cancelJob, cancelAllJobs, getJob, listJobs } from "./shared/job-registry.js";
import { runJob } from "./claude-sdk/orchestrator/orchestrator.js";
import { runJob as runLangChainJob } from "./langchain/langchain/orchestrator/graph.js";
import { runJob as runDeepAgentJob } from "./langchain/deepagent/orchestrator/graph.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

// ---------------------------------------------------------------------------
// POST /run  — start a new job
// ---------------------------------------------------------------------------
app.post("/run", async (req: Request, res: Response) => {
  const { jiraId } = req.body as { jiraId?: string };

  if (!jiraId || typeof jiraId !== "string" || !jiraId.trim()) {
    res.status(400).json({ ok: false, error: "jiraId is required" });
    return;
  }

  const jobId = randomUUID();
  console.log(`[POST /run] jiraId=${jiraId} jobId=${jobId}`);

  // Run async — respond immediately so the HTTP client isn't left hanging
  runJob(jiraId.trim(), jobId).catch((err) => {
    console.error(`[POST /run] job ${jobId} failed:`, err);
  });

  res.json({ ok: true, jobId });
});

// ---------------------------------------------------------------------------
// POST /run/langchain  — start a new job using the LangChain/LangGraph agent
// ---------------------------------------------------------------------------
app.post("/run/langchain", async (req: Request, res: Response) => {
  const { jiraId } = req.body as { jiraId?: string };

  if (!jiraId || typeof jiraId !== "string" || !jiraId.trim()) {
    res.status(400).json({ ok: false, error: "jiraId is required" });
    return;
  }

  const jobId = randomUUID();
  console.log(`[POST /run/langchain] jiraId=${jiraId} jobId=${jobId}`);

  // Run async — respond immediately so the HTTP client isn't left hanging
  runLangChainJob(jiraId.trim(), jobId).catch((err) => {
    console.error(`[POST /run/langchain] job ${jobId} failed:`, err);
  });

  res.json({ ok: true, jobId, agent: "langchain" });
});

// ---------------------------------------------------------------------------
// POST /run/deepagent  — start a new job using the Deep Agent pipeline
// ---------------------------------------------------------------------------
app.post("/run/deepagent", async (req: Request, res: Response) => {
  const { jiraId } = req.body as { jiraId?: string };

  if (!jiraId || typeof jiraId !== "string" || !jiraId.trim()) {
    res.status(400).json({ ok: false, error: "jiraId is required" });
    return;
  }

  const jobId = randomUUID();
  console.log(`[POST /run/deepagent] jiraId=${jiraId} jobId=${jobId}`);

  // Run async — respond immediately so the HTTP client isn't left hanging
  runDeepAgentJob(jiraId.trim(), jobId).catch((err) => {
    console.error(`[POST /run/deepagent] job ${jobId} failed:`, err);
  });

  res.json({ ok: true, jobId, agent: "deepagent" });
});

// ---------------------------------------------------------------------------
// POST /jobs/:id/cancel  — cancel a running job
// ---------------------------------------------------------------------------
app.post("/jobs/:id/cancel", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = getJob(id);

  if (!job) {
    res.status(404).json({ ok: false, error: `Job "${id}" not found` });
    return;
  }
  if (job.status !== "running") {
    res.status(409).json({ ok: false, error: `Job "${id}" is already ${job.status}` });
    return;
  }

  cancelJob(id);
  console.log(`[POST /jobs/${id}/cancel] Cancellation requested`);
  res.json({ ok: true, jobId: id, status: "cancelled" });
});

// ---------------------------------------------------------------------------
// GET /jobs/:id  — check job status
// ---------------------------------------------------------------------------
app.get("/jobs/:id", (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = getJob(id);

  if (!job) {
    res.status(404).json({ ok: false, error: `Job "${id}" not found` });
    return;
  }

  res.json({ ok: true, ...job });
});

// ---------------------------------------------------------------------------
// GET /jobs  — list all jobs
// ---------------------------------------------------------------------------
app.get("/jobs", (_req: Request, res: Response) => {
  res.json({ ok: true, jobs: listJobs() });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — cancel all running agent jobs before exiting
// ---------------------------------------------------------------------------
function shutdown(signal: string) {
  console.log(`\n[server] Received ${signal} — shutting down gracefully...`);

  // 1. Stop accepting new HTTP requests
  server.close(() => {
    console.log("[server] HTTP server closed");
  });

  // 2. Abort every running agent so they stop calling the Anthropic API
  const cancelled = cancelAllJobs();
  console.log(`[server] Cancelled ${cancelled} agent job(s)`);

  // 3. Give agents a moment to clean up, then hard-exit
  setTimeout(() => {
    console.log("[server] Exiting");
    process.exit(0);
  }, 1500).unref(); // .unref() so the timer doesn't keep the process alive by itself
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
