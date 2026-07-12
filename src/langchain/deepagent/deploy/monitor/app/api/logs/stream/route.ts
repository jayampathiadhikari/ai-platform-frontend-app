import { NextRequest } from "next/server";

// The agent container hostname on the Docker network (configurable via env)
const AGENT_BASE_URL = process.env.AGENT_URL ?? "http://localhost:3000";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MOCK_EVENTS = [
  { line: "[deep:orchestrator] [job-123] Starting Deep Agent job for jiraId=PROJ-105", source: "deepagent-agent" },
  { line: "[job-registry] Registered job job-123 (jiraId=PROJ-105)", source: "deepagent-agent" },
  { line: "[deep:resolveTicket] [job-123] Fetching ticket=PROJ-105", source: "deepagent-agent" },
  { line: "[deep:setupWorkspace] [job-123] Cloning repo and preparing workspace...", source: "deepagent-agent" },
  { line: "[workspace] [job-123] Clone complete", source: "deepagent-agent" },
  { line: "[deep:devAgent] [job-123] Handing off to DeepDevAgent (deepagents SDK)...", source: "deepagent-agent" },
  { line: "[deepagent:thinking] Let me start by reading the task specification and operational guidelines.", source: "deepagent-agent" },
  { line: "[deepagent:bash] [WRITE] → cd / && npm init -y", source: "deepagent-agent" },
  { line: "[deepagent:bash] [WRITE] ← Wrote to package.json", source: "deepagent-agent" },
  { line: "[deepagent:plan] Now add the start script and create .gitignore", source: "deepagent-agent" },
  { line: "[deepagent:bash] [INSTALL] → cd / && npm install express", source: "deepagent-agent" },
  { line: "[deepagent:response] Server works correctly. Now commit, push, and write REVIEW.json:", source: "deepagent-agent" },
  { line: "[deepagent:bash] [GIT:COMMIT/PUSH] → cd / && git commit -m 'feat'", source: "deepagent-agent" },
  { line: "[deepagent:bash] [GIT:COMMIT/PUSH] ← [agent/job-PROJ-105 921a2d5] feat(server)", source: "deepagent-agent" },
  { line: "[deep:postProcess] [job-123] PR #5 opened: https://github.com/jayampathiadhikari/ai-api-test-agent/pull/5", source: "deepagent-agent" },
  { line: "[deep:postProcess] [job-123] verdict=PASS", source: "deepagent-agent" },
  { line: "[deep:postProcess] [job-123] Job complete", source: "deepagent-agent" }
];

export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      // MOCK MODE: If you want to test the UI locally without the backend
      const searchParams = req.nextUrl.searchParams;
      if (process.env.NODE_ENV === "development") {
        let i = 0;
        const interval = setInterval(() => {
          if (i < MOCK_EVENTS.length) {
            send(JSON.stringify(MOCK_EVENTS[i]));
            i++;
          } else {
            clearInterval(interval);
          }
        }, 800);
        
        req.signal.addEventListener("abort", () => clearInterval(interval));
        return;
      }

      // --- Original Proxy Logic below ---
      const sendHeartbeat = () => {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
      };

      const hbInterval = setInterval(sendHeartbeat, 15_000);

      try {
        const upstream = await fetch(`${AGENT_BASE_URL}/logs/stream`, {
          signal: req.signal,
          headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        });

        if (!upstream.ok || !upstream.body) {
          send(JSON.stringify({ error: "Cannot connect to agent", ts: new Date().toISOString() }));
          clearInterval(hbInterval);
          controller.close();
          return;
        }

        const reader = upstream.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data:")) {
              controller.enqueue(encoder.encode(`${line}\n\n`));
            }
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("abort")) {
          send(JSON.stringify({ error: msg, ts: new Date().toISOString() }));
        }
      } finally {
        clearInterval(hbInterval);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

