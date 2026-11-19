import { env } from "@telnyx/edge-runtime";
import type { HoldInfo } from "./types.js";

const SHIM = process.env.SHELTER_ACTORS_URL ?? "https://shelter-actors-3ba87ec4-8.telnyxcompute.com";
const BEARER = process.env.MCP_BEARER ?? "";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface ShelterState {
  shelterId: string;
  name?: string;
  address?: string;
  directions?: string;
  location?: string;
  totalBeds: number;
  bedsAvailable: number;
  freeBedIds: string[];
}

function withExpiryInMinutes<T extends { hold?: HoldInfo }>(result: T): T {
  if (result?.hold) {
    result.hold.bedId = result.hold.bedId.replace(/^bed-/, "");
    (result.hold as HoldInfo).expires_in_minutes = Math.max(
      1,
      Math.ceil((result.hold.expiresAt - Date.now()) / 60000)
    );
  }
  return result;
}

interface ShelterIndexEntry {
  id: string;
  name: string;
  address: string;
  totalBeds: number;
  directions: string;
  location?: string;
  initialHolds?: number;
}

type ShelterIndex = { shelters: ShelterIndexEntry[] };

function text(payload: unknown, isError = false): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function shim<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${SHIM}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${BEARER}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`shim ${path} failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function findBeds(location?: string): Promise<unknown> {
  const index = await env.CACHE.get<ShelterIndex>("index/shelters", { type: "json" });
  if (!index) {
    return { shelters: [], note: "no shelter index seeded" };
  }
  const snapshots = await Promise.all(
    index.shelters.map(async (s) => {
      const cached = await env.CACHE.get<ShelterState>(`state/${s.id}`, { type: "json" });
      if (cached) return cached;
      return shim<ShelterState>(`/state/${s.id}`).catch(() => null);
    })
  );
  const results = snapshots
    .filter((s): s is ShelterState => s !== null)
    .filter((s) => {
      if (!location) return true;
      const query = location.toLowerCase().trim();
      const haystack = [s.name, s.address, s.directions, s.location].filter(Boolean).join(" ").toLowerCase();
      return query.split(/[^a-z0-9]+/i).some((word) => word && haystack.includes(word));
    });
  return {
    shelters: results.map((s) => ({
      shelter_id: s.shelterId,
      name: s.name,
      address: s.address,
      beds_available: s.bedsAvailable,
      total_beds: s.totalBeds,
    })),
  };
}

export async function holdBed(
  shelterId: string,
  callerId: string,
  holdMinutes: number
): Promise<unknown> {
  return withExpiryInMinutes(
    await shim<{
      ok: boolean;
      reason?: string;
      hold?: HoldInfo;
      bedsAvailable?: number;
    }>("/hold", { shelterId, callerId, holdMinutes })
  );
}

export async function extendHold(callerId: string, extendMinutes: number): Promise<unknown> {
  const cachedHold = await env.CACHE.get<HoldInfo>(`hold/${callerId}`, { type: "json" });
  if (!cachedHold) {
    return { ok: false, reason: "no_hold" };
  }
  const result = await shim<{
    ok: boolean;
    reason?: string;
    hold?: HoldInfo;
    bedsAvailable?: number;
  }>("/extend", { shelterId: cachedHold.shelterId, callerId, extendMinutes });
  if (result.ok) {
    await env.CACHE.put(`hold/${callerId}`, JSON.stringify(result.hold ?? result));
  }
  return result;
}

export async function holdStatus(callerId: string): Promise<unknown> {
  const cachedHold = await env.CACHE.get<HoldInfo>(`hold/${callerId}`, { type: "json" });
  if (!cachedHold) {
    return { hold: null, message: "no active hold for this caller" };
  }
  const result = await shim<{
    hold: HoldInfo | null;
    bedsAvailable: number;
    expires_in_minutes: number | null;
  }>(`/hold-status/${cachedHold.shelterId}/${callerId}`);
  if (!result.hold) {
    await env.CACHE.delete(`hold/${callerId}`);
    return { hold: null, message: "no active hold for this caller" };
  }
  return result;
}

export async function cancelHold(callerId: string): Promise<unknown> {
  const cachedHold = await env.CACHE.get<HoldInfo>(`hold/${callerId}`, { type: "json" });
  if (!cachedHold) {
    return { ok: false, reason: "no_hold" };
  }
  const result = await shim<{ ok: boolean; reason?: string; bedsAvailable?: number }>("/cancel", {
    shelterId: cachedHold.shelterId,
    callerId,
  });
  if (result.ok) {
    await env.CACHE.delete(`hold/${callerId}`);
  }
  return result;
}

export async function getDirections(shelterId: string): Promise<unknown> {
  const cached = await env.CACHE.get<ShelterState>(`state/${shelterId}`, { type: "json" });
  const state = cached ?? (await shim<ShelterState>(`/state/${shelterId}`));
  const index = await env.CACHE.get<ShelterIndex>("index/shelters", { type: "json" });
  const idx = index?.shelters.find((s) => s.id === shelterId);
  return {
    shelter_id: state.shelterId,
    name: state.name,
    directions: state.directions ?? idx?.directions,
  };
}

export async function listServices(category?: string): Promise<unknown> {
  const services = await env.CACHE.get<{ services: Record<string, string>[] }>(
    "index/services",
    { type: "json" }
  );
  const items = (services?.services ?? []).filter(
    (s) => !category || String(s.category).toLowerCase() === category.toLowerCase()
  );
  return { services: items };
}

export async function adminReset(shelterId: string): Promise<unknown> {
  const index = await env.CACHE.get<ShelterIndex>("index/shelters", { type: "json" });
  const seed = index?.shelters.find((s) => s.id === shelterId);
  if (!seed) {
    return { ok: false, bedsAvailable: 0 };
  }
  return shim<{ ok: boolean; bedsAvailable: number }>("/reset", {
    shelterId,
    initialHolds: seed.initialHolds ?? 0,
    seed: { name: seed.name, address: seed.address, directions: seed.directions, location: seed.location },
  });
}

export async function adminMetrics(): Promise<unknown> {
  return shim<{ counters: Record<string, number> }>("/counters");
}
