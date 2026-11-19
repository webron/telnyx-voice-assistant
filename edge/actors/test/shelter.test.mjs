#!/usr/bin/env node
import assert from "node:assert/strict";
import { Shelter } from "../src/shelter.ts";

function makeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      return map.delete(key);
    },
    async getAlarm() {
      return map.get("__alarm__") ?? null;
    },
    async setAlarm(when) {
      map.set("__alarm__", when);
    },
    async deleteAlarm() {
      map.delete("__alarm__");
    },
  };
}

function makeActor(seed = {}, holds) {
  const storage = makeStorage();
  storage.put("name", seed?.name ?? "Test Shelter");
  storage.put("address", seed?.address ?? "1 Test St, Waterfront District, Riverbend");
  storage.put("directions", seed?.directions ?? "Bus 1 from Central Station.");
  storage.put("location", seed?.location ?? "waterfront");
  storage.put("totalBeds", seed?.totalBeds ?? 3);
  storage.put("holds", holds ?? {});

  const kv = new Map();
  kv.set("index/shelters", JSON.stringify({
    shelters: [{
      id: "test-shelter",
      name: seed?.name ?? "Test Shelter",
      address: seed?.address ?? "1 Test St, Waterfront District, Riverbend",
      totalBeds: seed?.totalBeds ?? 3,
      directions: seed?.directions ?? "Bus 1 from Central Station.",
      location: seed?.location ?? "waterfront",
      initialHolds: seed?.initialHolds ?? 0,
    }],
  }));

  const env = {
    CACHE: {
      async get(k, o) {
        const v = kv.get(k);
        if (v === undefined) return null;
        return o?.type === "json" ? JSON.parse(v) : v;
      },
      async put(k, value) {
        kv.set(k, value);
      },
      async delete(k) {
        kv.delete(k);
      },
    },
    SHELTER: null,
  };

  const actor = Object.create(Shelter.prototype);
  actor.ctx = { id: seed?.id ?? "test-shelter", storage, setAlarm: (t) => storage.put("__alarm__", t) };
  actor.env = env;
  env.SHELTER = { idFromName: (id) => actor };

  // Model the platform runtime's single-threaded dispatch: method calls queue and
  // run one at a time (the guarantee that makes check-then-act safe in production).
  const queue = [];
  const serialize = (fn) => {
    const run = queue.length
      ? queue[queue.length - 1].then(() => fn())
      : fn();
    queue.push(run instanceof Promise ? run : Promise.resolve(run));
    return run;
  };
  for (const method of ["holdBed", "extendHold", "cancelHold", "state", "resetHolds"]) {
    actor[method] = (...args) => serialize(() => Shelter.prototype[method].apply(actor, args));
  }
  return actor;
}

const results = [];
function test(name, fn) {
  results.push({ name, fn });
}

test("holdBed places a hold and reports expires_in_minutes", async (a) => {
  const shelter = makeActor();
  const r = await shelter.holdBed("15551230001", 30);
  assert.equal(r.ok, true);
  assert.equal(r.hold.bedId, "bed-1");
  assert.ok(r.hold.expires_in_minutes >= 29 && r.hold.expires_in_minutes <= 30);
});

test("holdBed races: exactly one caller wins the last bed", async (a) => {
  const shelter = makeActor({ totalBeds: 1, initialHolds: 0 });
  const [r1, r2] = await Promise.all([
    shelter.holdBed("15551230001", 30),
    shelter.holdBed("15551230002", 30),
  ]);
  const winners = [r1, r2].filter((r) => r.ok);
  assert.equal(winners.length, 1);
  assert.equal([r1, r2].find((r) => !r.ok).reason, "no_beds");
});

test("holdBed denies a second hold for the same caller", async (a) => {
  const shelter = makeActor({ totalBeds: 3, initialHolds: 0 });
  const r1 = await shelter.holdBed("15551230001", 30);
  const r2 = await shelter.holdBed("15551230001", 30);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "already_holding");
});

test("extendHold pushes the expiry by the requested minutes", async (a) => {
  const shelter = makeActor({ totalBeds: 3, initialHolds: 0 });
  await shelter.holdBed("15551230001", 30);
  const before = (await shelter.state()).bedsAvailable;
  const r = await shelter.extendHold("15551230001", 30);
  assert.equal(r.ok, true);
  assert.ok(r.hold.expires_in_minutes >= 59 && r.hold.expires_in_minutes <= 60);
  assert.equal((await shelter.state()).bedsAvailable, before);
});

test("cancelHold releases the bed and clears the cache", async (a) => {
  const shelter = makeActor({ totalBeds: 3, initialHolds: 0 });
  await shelter.holdBed("15551230001", 30);
  const r = await shelter.cancelHold("15551230001");
  assert.equal(r.ok, true);
  assert.equal(r.bedsAvailable, 3);
  const cacheAfter = await shelter.env.CACHE.get("hold/15551230001");
  assert.equal(cacheAfter, null);
});

test("publishSnapshot includes directions for get_directions", async (a) => {
  const shelter = makeActor();
  await shelter.holdBed("15551230001", 30);
  const s = await shelter.state();
  assert.match(s.directions ?? "", /Bus/);
  assert.match(s.location ?? "", /waterfront/);
});

test("alarm is armed to the earliest hold expiry", async (a) => {
  const shelter = makeActor({ totalBeds: 3, initialHolds: 0 });
  const r = await shelter.holdBed("15551230001", 45);
  assert.equal(r.ok, true);
  const alarm = await shelter.ctx.storage.getAlarm();
  assert.ok(Math.abs(alarm - r.hold.expiresAt) < 2000);
});

for (const { name, fn } of results) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(String(err && err.stack ? err.stack : err));
    process.exitCode = 1;
  }
}
