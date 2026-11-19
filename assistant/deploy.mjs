#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const API = "https://api.telnyx.com";
const NAME = "Riverbend Shelter Bed Line";

function apiKey() {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY;
  const cfg = readFileSync(`${homedir()}/.telnyx-edge/config.toml`, "utf8");
  return cfg.match(/api_key = "([^"]+)"/)?.[1];
}

const KEY = apiKey();
const definition = JSON.parse(readFileSync(new URL("./assistant.json", import.meta.url), "utf8"));

const list = await fetch(`${API}/v2/ai/assistants?page%5Bsize%5D=50`, {
  headers: { Authorization: `Bearer ${KEY}` },
}).then((r) => r.json());

const existing = list.data?.find((a) => a.name === NAME);
const method = existing ? "PATCH" : "POST";
const url = existing ? `${API}/v2/ai/assistants/${existing.id}` : `${API}/v2/ai/assistants`;

async function send(method, url, payload, attempt = 1) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && attempt < 3 && JSON.stringify(body).includes("10015")) {
    console.log("transient 10015, retrying in 2s...");
    await new Promise((r) => setTimeout(r, 2000));
    return send(method, url, payload, attempt + 1);
  }
  return { res, body };
}

// Empirical API quirk (see build log): a PATCH with the full field set is only
// accepted when the keys are serialized in a specific order — greeting,
// voice_settings, dynamic-variables webhook, mcp_servers, instructions, then
// name, then model. Literal-key construction (no spread) is required.
const { conversation_flow, ...fields } = definition;
const ordered = {
  greeting: fields.greeting,
  voice_settings: fields.voice_settings,
  dynamic_variables_webhook_url: fields.dynamic_variables_webhook_url,
  dynamic_variables_webhook_timeout_ms: fields.dynamic_variables_webhook_timeout_ms,
  mcp_servers: fields.mcp_servers,
  instructions: fields.instructions,
  name: fields.name,
  model: fields.model,
};
let res;
let body;
if (existing) {
  ({ res, body } = await send("PATCH", url, ordered));
  if (res.ok) ({ res, body } = await send("PATCH", url, { conversation_flow }));
} else {
  ({ res, body } = await send("POST", url, definition));
}
if (!res.ok) {
  console.error(`assistant ${method} failed: ${res.status}`, JSON.stringify(body).slice(0, 800));
  process.exit(1);
}

const assistant = body.data ?? body;
console.log(`${existing ? "updated" : "created"} assistant ${assistant.id} (${assistant.name})`);
writeFileSync(new URL(".assistant-id", import.meta.url), assistant.id + "\n");

if (existing) {
  console.log("(mcp_servers, tool lists, and dynamic-variable webhook URLs are not part of conversation_flow;");
  console.log(" if the update response lacks them, verify with GET /v2/ai/assistants/{id})");
}
