import { Shelter, type ShelterSeed } from "./shelter";

export { Shelter };

const BEARER = process.env.MCP_BEARER ?? "";

function authorize(req: Request): boolean {
  if (!BEARER) return true;
  const header = req.headers.get("authorization") ?? "";
  const h = header.toLowerCase();
  return h === `bearer ${BEARER.toLowerCase()}` || h === BEARER.toLowerCase();
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

async function maybeBump(e: Env, key: string): Promise<void> {
  try {
    const counters = (e as unknown as { COUNTERS?: { idFromName(n: string): { bump(k: string): Promise<number> } } }).COUNTERS;
    await counters?.idFromName("global").bump(key);
  } catch (err) {
    console.warn(JSON.stringify({ msg: "metrics-bump-skipped", key, error: String(err) }));
  }
}

async function route(req: Request, e: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/health" || path === "/health/liveness" || path === "/health/readiness")) {
    return Response.json({ ok: true });
  }

  if (!authorize(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (req.method === "GET" && /^\/state\/[a-z0-9-]+$/.test(path)) {
    const shelterId = path.split("/")[2];
    const state = await e.SHELTER.idFromName(shelterId).state();
    return Response.json(state);
  }

  if (req.method === "POST" && path === "/hold") {
    const { shelterId, callerId, holdMinutes } = await readJson(req);
    const result = await e.SHELTER.idFromName(shelterId).holdBed(callerId, holdMinutes ?? 30);
    await maybeBump(e, "holds_placed");
    return Response.json(result);
  }

  if (req.method === "POST" && path === "/extend") {
    const { shelterId, callerId, extendMinutes } = await readJson(req);
    const result = await e.SHELTER.idFromName(shelterId).extendHold(callerId, extendMinutes ?? 30);
    await maybeBump(e, "holds_extended");
    return Response.json(result);
  }

  if (req.method === "GET" && /^\/hold-status\/[a-z0-9-]+\/\d+$/.test(path)) {
    const parts = path.split("/");
    const result = await e.SHELTER.idFromName(parts[2]).holdFor(parts[3]);
    return Response.json(result);
  }

  if (req.method === "POST" && path === "/cancel") {
    const { shelterId, callerId } = await readJson(req);
    const result = await e.SHELTER.idFromName(shelterId).cancelHold(callerId);
    await maybeBump(e, result.ok ? "holds_cancelled" : "cancels_denied");
    return Response.json(result);
  }

  if (req.method === "POST" && path === "/reset") {
    const { shelterId, initialHolds, seed } = await readJson(req);
    const result = await e.SHELTER.idFromName(shelterId).resetHolds(initialHolds ?? 0, seed);
    await maybeBump(e, "admin_resets");
    return Response.json(result);
  }

  if (req.method === "GET" && path === "/warm") {
    const index = await e.CACHE.get<{ shelters: ShelterSeed[] }>("index/shelters", { type: "json" });
    if (!index) return Response.json({ warmed: 0 });
    const results = await Promise.allSettled(
      index.shelters.slice(0, 5).map((s) => e.SHELTER.idFromName(s.id).state())
    );
    const warmed = results.filter((r) => r.status === "fulfilled").length;
    return Response.json({ warmed });
  }

  if (req.method === "GET" && path === "/counters") {
    return Response.json({ counters: {}, note: "counters moved to logs" });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(req: Request, e: Env): Promise<Response> {
    try {
      return await route(req, e);
    } catch (err) {
      console.error(JSON.stringify({ msg: "shim-error", error: String(err) }));
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  },
};
