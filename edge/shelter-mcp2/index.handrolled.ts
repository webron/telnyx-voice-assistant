import * as http from "node:http";
import { env } from "@telnyx/edge-runtime";
import {
  findBeds,
  holdBed,
  extendHold,
  cancelHold,
  getDirections,
  listServices,
  adminReset,
  adminMetrics,
  ToolResult,
} from "./tools.js";

const TOOL_DEFS = [
  { name: "find_beds", description: "List shelter beds available tonight. Call when the caller needs a place to sleep.", inputSchema: { type: "object", properties: { location: { type: "string", description: "Area the caller can reach" } } } },
  { name: "hold_bed", description: "Hold one open bed for the caller at a specific shelter for 30 minutes. One hold per caller.", inputSchema: { type: "object", properties: { shelter_id: { type: "string" }, caller_id: { type: "string" }, hold_minutes: { type: "number" } }, required: ["shelter_id", "caller_id"] } },
  { name: "extend_hold", description: "Extend a caller's existing bed hold by a number of minutes.", inputSchema: { type: "object", properties: { caller_id: { type: "string" }, extend_minutes: { type: "number" } }, required: ["caller_id"] } },
  { name: "cancel_hold", description: "Cancel a caller's active bed hold, returning the bed to the pool.", inputSchema: { type: "object", properties: { caller_id: { type: "string" } }, required: ["caller_id"] } },
  { name: "get_directions", description: "Transit directions to a shelter.", inputSchema: { type: "object", properties: { shelter_id: { type: "string" } }, required: ["shelter_id"] } },
  { name: "list_services", description: "List local support services near the caller.", inputSchema: { type: "object", properties: { category: { type: "string" } } } },
  { name: "admin_reset", description: "Reset a shelter to its seeded state. Not for callers.", inputSchema: { type: "object", properties: { shelter_id: { type: "string" } }, required: ["shelter_id"] } },
  { name: "admin_metrics", description: "Return business-event counters. Not for callers.", inputSchema: { type: "object", properties: {} } },
];

const TOOLS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  find_beds: (a) => findBeds(a.location as string | undefined),
  hold_bed: (a) => holdBed(a.shelter_id as string, a.caller_id as string, (a.hold_minutes as number) ?? 30),
  extend_hold: (a) => extendHold(a.caller_id as string, (a.extend_minutes as number) ?? 30),
  cancel_hold: (a) => cancelHold(a.caller_id as string),
  get_directions: (a) => getDirections(a.shelter_id as string),
  list_services: (a) => listServices(a?.category as string | undefined),
  admin_reset: (a) => adminReset(a.shelter_id as string),
  admin_metrics: async () => adminMetrics(),
};

const SERVER_INFO = { name: "shelter-line-mcp", version: "0.1.0" };
const BEARER = process.env.MCP_BEARER ?? "";

const sessions = new Set<string>();

function bearerOk(req: http.IncomingMessage): boolean {
  if (!BEARER) return true;
  const header = req.headers.authorization ?? "";
  const h = header.toLowerCase();
  const ok = h === `bearer ${BEARER.toLowerCase()}` || h === BEARER.toLowerCase();
  if (!ok) {
    console.log(JSON.stringify({ msg: "mcp-auth-rejected", authPresent: header.length > 0 }));
  }
  return ok;
}

async function handleRpc(rpcId: string | number | null, method: string, params: any, e: Env, res: http.ServerResponse): Promise<void> {
  const started = Date.now();
  const reqId = params?.meta?.requestId ?? crypto.randomUUID();
  switch (method) {
    case "initialize": {
      const sessionId = crypto.randomUUID();
      sessions.add(sessionId);
      res.setHeader("mcp-session-id", sessionId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0", id: rpcId,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      }));
      return;
    }
    case "tools/list": {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: { tools: TOOL_DEFS } }));
      return;
    }
    case "tools/call": {
      const tool = params?.name as string;
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const fn = TOOLS[tool];
      if (!fn) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${tool}` }) }], isError: true } }));
        return;
      }
      const data = await fn(args);
      const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      console.log(JSON.stringify({ msg: "mcp-tool", req: reqId, tool, isError: result.isError ?? false, latencyMs: Date.now() - started }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, result }));
      return;
    }
    default: {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpcId, error: { code: -32601, message: `method not found: ${method}` } }));
      return;
    }
  }
}

function sseStream(): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const beat = () => {
    try {
      res.write(": heartbeat\n\n");
    } catch {}
  };
  beat();
  const timer = setInterval(beat, 8000);
  setTimeout(() => {
    clearInterval(timer);
    try {
      res.end();
    } catch {}
  }, 25000);
}

let res: http.ServerResponse;

const server = http.createServer(async (req: http.IncomingMessage, r: http.ServerResponse) => {
  res = r;
  const url = req.url ?? "";

  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!bearerOk(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (req.method === "GET") {
    sseStream();
    return;
  }

  if (req.method === "DELETE") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", async () => {
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    if (parsed.id === null || parsed.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    try {
      await handleRpc(parsed.id, parsed.method, parsed.params, env, res);
    } catch (err) {
      console.error(JSON.stringify({ msg: "mcp-handler-error", error: String(err) }));
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, error: { code: -32603, message: "internal error" } }));
      }
    }
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "mcp-server-listening", node: process.version, port }));
});
