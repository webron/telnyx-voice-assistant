#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const NAMESPACE_ID = "143ab59c-3b74-422e-8c5e-33469877515b";
const API = "https://api.telnyx.com";

function apiKey() {
  if (process.env.TELNYX_API_KEY) return process.env.TELNYX_API_KEY;
  const cfg = readFileSync(`${homedir()}/.telnyx-edge/config.toml`, "utf8");
  const m = cfg.match(/api_key = "([^"]+)"/);
  if (!m) throw new Error("no TELNYX_API_KEY and none found in ~/.telnyx-edge/config.toml");
  return m[1];
}

const KEY = apiKey();

async function put(key, value) {
  const res = await fetch(`${API}/v2/storage/kvs/${NAMESPACE_ID}/keys/${key}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/octet-stream" },
    body: JSON.stringify(value, null, 2),
  });
  if (!res.ok) throw new Error(`put ${key}: ${res.status} ${await res.text()}`);
  console.log(`put ${key} ok`);
}

const shelters = {
  shelters: [
    {
      id: "riverbend-cedar",
      name: "Cedar House",
      address: "411 Maple St, Maple District, Riverbend",
      location: "maple district, midtown",
      totalBeds: 12,
      directions: "Bus 4 from Central Station to Maple & 5th, then two blocks east. Check in at the side entrance before 21:00.",
      initialHolds: 10,
    },
    {
      id: "riverbend-harbor",
      name: "Harborlight Center",
      address: "55 Docks Ln, Waterfront District, Riverbend",
      location: "waterfront, harbor, docks",
      totalBeds: 15,
      directions: "Bus 12 along the waterfront to Harborlight stop. The entrance faces the pier.",
      initialHolds: 0,
    },
    {
      id: "riverbend-faith",
      name: "Faith Commons",
      address: "22 Meridian Ave, Meridian District, Riverbend",
      location: "meridian, downtown, grand",
      totalBeds: 8,
      directions: "Bus 3 to Meridian & Grand, then one block north. Intake desk at the rear.",
      initialHolds: 7,
    },
    {
      id: "riverbend-oakside",
      name: "Oakside Shelter",
      address: "190 Oak Rd, Oak Hill, Riverbend",
      location: "oak hill, west side",
      totalBeds: 6,
      directions: "Bus 7 to Oak Rd & 3rd, then a short walk up the hill. Look for the blue door.",
      initialHolds: 0,
    },
    {
      id: "riverbend-trinity",
      name: "Trinity House",
      address: "9 Chapel Sq, Chapel Quarter, Riverbend",
      location: "chapel quarter, central station",
      totalBeds: 3,
      directions: "Walk three blocks from Central Station to Chapel Square; the house is on the square's west side.",
      initialHolds: 2,
    },
  ],
};

const services = {
  services: [
    { name: "Riverbend Community Kitchen", category: "food", address: "700 State St, Downtown, Riverbend", hours: "Dinner 17:00-19:00 daily", phone: "555-0101", directions: "Walk three blocks south from Central Station on State St; the kitchen is the brick building with the green awning. Bus 6 to State & Central also stops at the door." },
    { name: "Harborlight Showers", category: "showers", address: "55 Docks Ln, Waterfront District, Riverbend", hours: "08:00-15:00 daily", phone: "555-0102", directions: "Same waterfront building as Harborlight Center — Bus 12 along the waterfront to the Harborlight stop; showers are through the pier-side entrance." },
    { name: "Riverbend Free Clinic", category: "medical", address: "128 Meridian Ave, Meridian District, Riverbend", hours: "Walk-in 09:00-12:00, Mon-Fri", phone: "555-0103", directions: "Bus 3 to Meridian & Grand, then walk one block north; the clinic is in the blue two-storey building on the left." },
    { name: "Day Center at Grace Hall", category: "day_center", address: "18 Church St, Chapel Quarter, Riverbend", hours: "07:00-17:00 daily", phone: "555-0104", directions: "Two blocks east of Chapel Square on Church St; enter through the courtyard on the right." },
    { name: "Legal Aid Society", category: "legal", address: "44 Court Sq, Riverbend", hours: "Intake 10:00-13:00 Tue/Thu", phone: "555-0105", directions: "Bus 4 to Court Sq & 2nd; the office is on the north side of the square, next to the fountain." },
  ],
};

await put("index/shelters", shelters);
await put("index/services", services);
console.log("seed complete");
