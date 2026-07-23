/**
 * A tiny Node http → web-fetch adapter so we can serve a Hono app without an
 * extra dependency (D-25). The response body is **streamed** chunk-by-chunk, so
 * SSE (text/event-stream, the P5 event bus §11) flushes live and long-lived
 * connections stay open; finite bodies (JSON, static assets) end normally.
 * Node 20+ provides global Request/Response/ReadableStream.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type FetchHandler = (request: Request) => Response | Promise<Response>;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handle(fetchHandler: FetchHandler, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const hasBody = method !== "GET" && method !== "HEAD";
    const request = new Request(url, { method, headers, body: hasBody ? await readBody(req) : undefined });

    const response = await fetchHandler(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((val, key) => (outHeaders[key] = val));
    res.writeHead(response.status, outHeaders);

    if (!response.body) {
      res.end();
      return;
    }
    // Stream the web ReadableStream to the Node response so SSE flushes live.
    const reader = response.body.getReader();
    let aborted = false;
    res.on("close", () => {
      aborted = true;
      void reader.cancel().catch(() => {});
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done || aborted) break;
      if (value) res.write(Buffer.from(value));
    }
    if (!aborted) res.end();
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

export function startNodeServer(
  fetchHandler: FetchHandler,
  options: { host: string; port: number },
): Promise<Server> {
  const server = createServer((req, res) => void handle(fetchHandler, req, res));
  return new Promise((resolve) => server.listen(options.port, options.host, () => resolve(server)));
}
