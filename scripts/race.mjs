#!/usr/bin/env node
import { readFileSync } from "node:fs";

const envPath = new URL("../.env", import.meta.url).pathname;
const MCP_BEARER = process.env.MCP_BEARER ?? readFileSync(envPath, "utf8").match(/MCP_BEARER=(.+)/)?.[1];
const MCP_URL = process.env.MCP_URL ?? process.argv[2];

async function callTool(name, args) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${MCP_BEARER}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1e6),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = await res.json();
  const inner = JSON.parse(body.result.content[0].text);
  return inner;
}

const shelterId = process.argv[3] ?? "riverbend-faith";
const callers = process.argv.slice(4).length
  ? process.argv.slice(4)
  : [1, 2].map((i) => `race${Date.now()}${i}`);

console.log(`racing: ${callers.join(" vs ")} for the last bed at ${shelterId}`);
await callTool("admin_reset", { shelter_id: shelterId });
const results = await Promise.all(
  callers.map((c) =>
    callTool("hold_bed", { shelter_id: shelterId, caller_id: c }).then(
      (r) => ({ caller: c, ok: r.ok, reason: r.reason, bedId: r.hold?.bedId })
    )
  )
);
for (const r of results) console.log(JSON.stringify(r));
const winners = results.filter((r) => r.ok);
console.log(winners.length === 1 ? "PASS: exactly one caller won the last bed" : `FAIL: ${winners.length} winners`);
