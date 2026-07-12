import { NextRequest } from "next/server";

// The agent container hostname on the Docker network (configurable via env)
const AGENT_BASE_URL = process.env.AGENT_URL ?? "http://agent:3000";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/logs/stream
 *
 * Proxies the SSE stream from the deepagent-agent container's
 * /logs/stream endpoint. In development (no AGENT_URL), falls back
 * to http://localhost:3000.
 */
export async function GET(req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: string) => {
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      };

      const sendHeartbeat = () => {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
      };

      // Heartbeat every 15s to keep connection alive through proxies
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
              // Forward SSE data lines verbatim
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
