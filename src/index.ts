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
// SSE log broadcaster — intercepts console output and fans it out to any
// connected monitor clients over GET /logs/stream.
// ---------------------------------------------------------------------------
const LOG_BUFFER_SIZE = 500;
const logBuffer: string[] = [];                       // ring-buffer of recent lines
const sseClients = new Set<Response>();               // active SSE connections

function broadcastLog(line: string) {
  // Keep ring buffer
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();

  // Fan out to connected clients
  const payload = `data: ${JSON.stringify({ line, source: "deepagent-agent" })}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Patch console methods to also send to broadcaster
(["log", "warn", "error", "info", "debug"] as const).forEach(method => {
  const original = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    original(...args);
    const line = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    broadcastLog(line);
  };
});

// ---------------------------------------------------------------------------
// POST /run  — start a new job
// ---------------------------------------------------------------------------
app.post("/run", async (req: Request, res: Response) => {
  const { jiraId } = req.body as { jiraId?: string };

  if (!jiraId || typeof jiraId !== "string" || !jiraId.trim()) {
    res.status(400).json({ ok: false, error: "jiraId is required" });
    return;
  }

  const jobId = `job-${jiraId.trim()}-${Date.now()}`;
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

  const jobId = `job-${jiraId.trim()}-${Date.now()}`;
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

  const jobId = `job-${jiraId.trim()}-${Date.now()}`;
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
// GET /logs/stream  — SSE stream of all console output (for the monitor UI)
// ---------------------------------------------------------------------------
app.get("/logs/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Replay recent buffer to the new client
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify({ line, source: "deepagent-agent" })}\n\n`);
  }

  sseClients.add(res);

  // Heartbeat every 15 s
  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
  }, 15_000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(hb);
  });
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
