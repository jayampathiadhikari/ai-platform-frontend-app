import express from "express";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { runJob } from "./orchestrator/orchestrator.js";

const app = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());

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

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
