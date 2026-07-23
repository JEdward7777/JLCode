/**
 * A tiny Node http → web-fetch adapter so we can serve a Hono app without an
 * extra dependency (D-25). Good enough for JSON endpoints; Node 24 provides
 * global Request/Response. The full Phase 5 server can adopt a richer adapter
 * (streaming/SSE) later.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

type FetchHandler = (request: Request) => Response | Promise<Response>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
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
    res.end(await response.text());
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
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
