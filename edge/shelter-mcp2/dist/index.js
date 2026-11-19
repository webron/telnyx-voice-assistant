import * as http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { findBeds, holdBed, extendHold, cancelHold, getDirections, listServices, adminReset, adminMetrics, } from "./tools.js";
const SERVER_INFO = { name: "shelter-line-mcp", version: "0.3.0" };
const BEARER = process.env.MCP_BEARER ?? "";
function buildMcpServer() {
    const server = new McpServer(SERVER_INFO);
    const register = (name, config, fn) => {
        const handler = async (args) => {
            const started = Date.now();
            const result = (await fn(args ?? {}));
            console.log(JSON.stringify({
                msg: "mcp-tool",
                tool: name,
                caller: args?.caller_id ?? undefined,
                latencyMs: Date.now() - started,
            }));
            return result;
        };
        server.registerTool(name, config, handler);
    };
    const wrap = (data) => ({
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    });
    register("find_beds", {
        title: "Find open beds",
        description: "List shelter beds available tonight in Riverbend. Call when the caller needs a place to sleep.",
        inputSchema: { location: z.string().optional().describe("Area the caller can reach") },
    }, async (args) => wrap(await findBeds(args?.location)));
    register("hold_bed", {
        title: "Hold a bed",
        description: "Hold one open bed for the caller at a specific shelter for 30 minutes. One hold per caller.",
        inputSchema: {
            shelter_id: z.string().describe("Shelter id from find_beds"),
            caller_id: z.string().describe("Caller id, digits only"),
            hold_minutes: z.number().optional().describe("Hold duration in minutes, default 30"),
        },
    }, async (args) => wrap(await holdBed(args.shelter_id, args.caller_id, args.hold_minutes ?? 30)));
    register("extend_hold", {
        title: "Extend a hold",
        description: "Extend a caller's existing bed hold by a number of minutes.",
        inputSchema: {
            caller_id: z.string().describe("Caller id, digits only"),
            extend_minutes: z.number().optional().describe("Minutes to add, default 30"),
        },
    }, async (args) => wrap(await extendHold(args.caller_id, args.extend_minutes ?? 30)));
    register("cancel_hold", {
        title: "Cancel a hold",
        description: "Cancel a caller's active bed hold, returning the bed to the pool.",
        inputSchema: { caller_id: z.string().describe("Caller id, digits only") },
    }, async (args) => wrap(await cancelHold(args.caller_id)));
    register("get_directions", {
        title: "Get directions",
        description: "Transit directions to a shelter.",
        inputSchema: { shelter_id: z.string().describe("Shelter id from find_beds") },
    }, async (args) => wrap(await getDirections(args.shelter_id)));
    register("list_services", {
        title: "List local services",
        description: "List local support services (food, showers, medical, legal) near the caller.",
        inputSchema: {
            category: z.string().optional().describe("Filter, e.g. food, showers, medical"),
        },
    }, async (args) => wrap(await listServices(args?.category)));
    register("admin_reset", {
        title: "Reset a shelter to its seeded state",
        description: "Reset a shelter's bed inventory. Not for callers.",
        inputSchema: { shelter_id: z.string() },
    }, async (args) => wrap(await adminReset(args.shelter_id)));
    register("admin_metrics", {
        title: "Show business-event counters",
        description: "Return hold metrics counters. Not for callers.",
        inputSchema: {},
    }, async () => wrap(await adminMetrics()));
    return server;
}
const sessions = new Map();
function authorize(req) {
    if (!BEARER)
        return true;
    const header = req.headers.authorization ?? "";
    const h = header.toLowerCase();
    return h === `bearer ${BEARER.toLowerCase()}` || h === BEARER.toLowerCase();
}
function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (c) => (body += c.toString()));
        req.on("end", () => resolve(body));
    });
}
async function handleMcp(req, res) {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (req.method === "GET") {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        const beat = () => {
            try {
                res.write(": heartbeat\n\n");
            }
            catch { }
        };
        beat();
        const timer = setInterval(beat, 8000);
        setTimeout(() => {
            clearInterval(timer);
            try {
                res.end();
            }
            catch { }
        }, 25000);
        return;
    }
    const raw = await readBody(req);
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
    }
    const isNotification = parsed.id === null || parsed.id === undefined;
    if (isNotification) {
        res.writeHead(202);
        res.end();
        return;
    }
    const isInitialize = parsed.method === "initialize";
    if (session && !isInitialize) {
        await session.transport.handleRequest(req, res, parsed);
        return;
    }
    if (!isInitialize) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id ?? null, error: { code: -32000, message: "initialize first" } }));
        return;
    }
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id) => {
            sessions.set(id, { transport });
        },
    });
    transport.onclose = () => {
        if (transport.sessionId)
            sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
}
const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/health")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
    }
    if (!authorize(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
        res.writeHead(405);
        res.end();
        return;
    }
    try {
        await handleMcp(req, res);
    }
    catch (err) {
        console.error(JSON.stringify({ msg: "mcp-handler-error", error: String(err) }));
        if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } }));
        }
    }
});
const port = process.env.PORT || 8080;
server.listen(port, () => {
    console.log(JSON.stringify({ msg: "mcp-server-listening", node: process.version, port }));
});
