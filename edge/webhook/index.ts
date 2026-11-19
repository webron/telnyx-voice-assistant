import * as http from "node:http";
import * as crypto from "node:crypto";
import { env } from "@telnyx/edge-runtime";

const PUBLIC_KEY_URL = "https://api.telnyx.com/v2/public_key";
const SHIM = "https://shelter-actors-3ba87ec4-8.telnyxcompute.com";
const EMERGENCY_KEY = "flag/emergency_mode";

let cachedPublicKey: string | null = null;

async function publicKey(): Promise<string> {
  const injected = process.env.TELNYX_PUBLIC_KEY;
  if (injected) return injected;
  const apiKey = process.env.TELNYX_API_KEY ?? "";
  const res = await fetch(PUBLIC_KEY_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(
      `public_key fetch ${res.status}: keylen=${apiKey.length} body=${errBody.slice(0, 300)}`
    );
  }
  const body = (await res.json()) as any;
  const key = body?.data?.public ?? body?.data?.public_key;
  if (!key) throw new Error(`public_key missing in response: ${JSON.stringify(body).slice(0, 200)}`);
  return key;
}

function toVerifyKey(pemOrB64: string): crypto.KeyObject {
  if (pemOrB64.includes("-----BEGIN")) {
    return crypto.createPublicKey(pemOrB64);
  }
  const raw = Buffer.from(pemOrB64, "base64");
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    raw,
  ]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

function verifySignature(rawBody: string, signatureHeader: string | null, timestampHeader: string | null, publicKeyPem: string): boolean {
  if (!signatureHeader || !timestampHeader) return false;
  const signed = `${timestampHeader}|${rawBody}`;
  const signature = Buffer.from(signatureHeader, "base64");
  return crypto.verify(
    null,
    Buffer.from(signed, "utf8"),
    toVerifyKey(publicKeyPem),
    signature
  );
}

function digitsOnly(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits || null;
}

interface HoldCache {
  shelterId: string;
  bedId: string;
  createdAt: number;
  expiresAt: number;
}

interface CallerVariables {
  caller_id: string;
  caller_name: string;
  has_active_hold: string;
  hold_shelter?: string;
  hold_bed?: string;
  hold_expires_min?: string;
  emergency_mode: string;
  is_return_caller: string;
}

async function callerVariables(callerDigits: string): Promise<CallerVariables> {
  const [hold, profile, flag] = await Promise.all([
    env.CACHE.get<HoldCache>(`hold/${callerDigits}`, { type: "json" }),
    env.CACHE.get<{ name: string; lastShelter?: string }>(`profile/${callerDigits}`, { type: "json" }),
    env.CACHE.get(EMERGENCY_KEY),
  ]);

  const now = Date.now();
  const active = hold && hold.expiresAt > now;
  const emergency = flag ? flag.trim().toLowerCase() === "on" : false;

  return {
    caller_id: callerDigits,
    caller_name: profile?.name ?? "",
    has_active_hold: active ? "true" : "false",
    hold_shelter: active ? hold!.shelterId : undefined,
    hold_bed: active ? hold!.bedId : undefined,
    hold_expires_min: active ? String(Math.max(1, Math.ceil((hold!.expiresAt - now) / 60_000))) : undefined,
    emergency_mode: emergency ? "true" : "false",
    is_return_caller: profile ? "true" : "false",
  };
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = req.url ?? "";

  if (req.method === "GET" && url.startsWith("/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }

  let raw = "";
  req.on("data", (c: Buffer) => (raw += c.toString()));
  req.on("end", async () => {
    const log = (extra: Record<string, unknown>) =>
      console.log(
        JSON.stringify({ msg: "dv-webhook", path: url, latencyMs: Date.now() - started, ...extra })
      );

    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      log({ outcome: "bad_json" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }

    const sig = req.headers["telnyx-signature-ed25519"] as string | undefined;
    const ts = req.headers["telnyx-timestamp"] as string | undefined;

    try {
      const keyPem = process.env.TEST_PUBLIC_KEY_PEM || (await publicKey());
      if (!verifySignature(raw, sig ?? null, ts ?? null, keyPem)) {
        log({ outcome: "bad_signature", caller: event?.data?.payload?.telnyx_end_user_target ?? undefined });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid signature" }));
        return;
      }
    } catch (err) {
      log({ outcome: "signature_check_error", error: String(err) });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "signature verification failed" }));
      return;
    }

    const payload = event?.data?.payload ?? {};
    const callerDigits =
      digitsOnly(payload.telnyx_end_user_target) ??
      digitsOnly(payload.caller_number) ??
      digitsOnly(payload.from) ??
      "";

    let variables: CallerVariables;
    try {
      variables = callerDigits
        ? await callerVariables(callerDigits)
        : { caller_id: "", caller_name: "", has_active_hold: "false", emergency_mode: "false", is_return_caller: "false" };
    } catch (err) {
      log({ outcome: "lookup_error", error: String(err) });
      variables = {
        caller_id: callerDigits,
        caller_name: "",
        has_active_hold: "false",
        emergency_mode: "false",
        is_return_caller: "false",
      };
    }

    log({
      outcome: "ok",
      caller: callerDigits,
      has_active_hold: variables.has_active_hold,
      emergency: variables.emergency_mode,
    });

    // Fire-and-forget actor warming: the shim awaits its own calls server-side.
    fetch(`${SHIM}/warm`, { headers: { authorization: `Bearer ${process.env.MCP_BEARER ?? ""}` } }).catch(
      () => {}
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ dynamic_variables: variables }));
  });
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "webhook-listening", node: process.version, port }));
});
