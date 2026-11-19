import { env } from "@telnyx/edge-runtime";
const SHIM = process.env.SHELTER_ACTORS_URL ?? "https://shelter-actors-3ba87ec4-8.telnyxcompute.com";
const BEARER = process.env.MCP_BEARER ?? "";
function text(payload, isError = false) {
    return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        ...(isError ? { isError: true } : {}),
    };
}
async function shim(path, body) {
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
    return (await res.json());
}
export async function findBeds(location) {
    const index = await env.CACHE.get("index/shelters", { type: "json" });
    if (!index) {
        return { shelters: [], note: "no shelter index seeded" };
    }
    const snapshots = await Promise.all(index.shelters.map(async (s) => {
        const cached = await env.CACHE.get(`state/${s.id}`, { type: "json" });
        if (cached)
            return cached;
        return shim(`/state/${s.id}`).catch(() => null);
    }));
    const results = snapshots
        .filter((s) => s !== null)
        .filter((s) => {
        if (!location)
            return true;
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
export async function holdBed(shelterId, callerId, holdMinutes) {
    return shim("/hold", { shelterId, callerId, holdMinutes });
}
export async function extendHold(callerId, extendMinutes) {
    const cachedHold = await env.CACHE.get(`hold/${callerId}`, { type: "json" });
    if (!cachedHold) {
        return { ok: false, reason: "no_hold" };
    }
    const result = await shim("/extend", { shelterId: cachedHold.shelterId, callerId, extendMinutes });
    if (result.ok) {
        await env.CACHE.put(`hold/${callerId}`, JSON.stringify(result.hold ?? result));
    }
    return result;
}
export async function cancelHold(callerId) {
    const cachedHold = await env.CACHE.get(`hold/${callerId}`, { type: "json" });
    if (!cachedHold) {
        return { ok: false, reason: "no_hold" };
    }
    const result = await shim("/cancel", {
        shelterId: cachedHold.shelterId,
        callerId,
    });
    if (result.ok) {
        await env.CACHE.delete(`hold/${callerId}`);
    }
    return result;
}
export async function getDirections(shelterId) {
    const cached = await env.CACHE.get(`state/${shelterId}`, { type: "json" });
    const state = cached ?? (await shim(`/state/${shelterId}`));
    return {
        shelter_id: state.shelterId,
        name: state.name,
        directions: state.directions,
    };
}
export async function listServices(category) {
    const services = await env.CACHE.get("index/services", { type: "json" });
    const items = (services?.services ?? []).filter((s) => !category || String(s.category).toLowerCase() === category.toLowerCase());
    return { services: items };
}
export async function adminReset(shelterId) {
    const index = await env.CACHE.get("index/shelters", { type: "json" });
    const seed = index?.shelters.find((s) => s.id === shelterId);
    if (!seed) {
        return { ok: false, bedsAvailable: 0 };
    }
    return shim("/reset", {
        shelterId,
        initialHolds: seed.initialHolds ?? 0,
        seed: { name: seed.name, address: seed.address, directions: seed.directions, location: seed.location },
    });
}
export async function adminMetrics() {
    return shim("/counters");
}
