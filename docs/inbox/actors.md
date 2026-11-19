# Telnyx Stateful Actors — research notes

Research task: actors execution model, TS API, RMW semantics, scheduled work, sharing, DevEx friction.
All claims checked against the live docs on 2026-11-09. Stateful Actors are **Beta**.
Sources fetched: main page, quick-start, concepts/how-it-works, concepts/execution-model,
concepts/addressing, concepts/lifecycle, api-reference (+ base, context, storage, stub,
namespace, errors, configuration), guides/project-structure, guides/when-to-use,
guides/storage/key-value, guides/storage/sql, shared-actors, alarms, websockets,
websockets/lifecycle, runtime/bindings, llms.txt index.

**URL note:** the three URLs given in the research brief all 404'd. Correct paths add
`/edge-compute` after `/docs`. Working URLs used throughout below. No content contradictions
found between pages; the only discrepancies are the URL paths and a few doc-seams noted under Gotchas.

---

## 1. Execution model

**Single-threaded per entity — yes, and it's the headline guarantee.**
"Exactly one instance per name. `idFromName("acct_123")` routes every call for that name
to one owner... No two hosts run account `acct_123` at once." And: "One call at a time —
no concurrency inside an instance. One thread per instance runs each method to completion
before the next starts. `await` yields the thread, but the next call still won't start
until your method returns."
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/execution-model

- Precise nuance: `await` inside a method yields the thread but does NOT let the next
  queued call start — interleaving happens only at method boundaries, never inside one.
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/execution-model
- Different names run in parallel (separate instances, separate threads, separate storage);
  one hot name is one single-threaded bottleneck (~1/method-wall-time calls/sec ceiling).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/when-to-use

**How instances are identified.** `env.<BINDING>` is an `ActorNamespace`:
`idFromName(name, options?)` (deterministic shard key — same name, same instance, from
anywhere) and `newUniqueId(options?)` (random, unguessable; keep `stub.id` to reach it
again). Both return an `ActorStub`; calling a method on the stub is an RPC that queues at
the one instance. `idFromName` is described as "the actor-world `lookup_or_create`" —
it routes to the one owner of that name anywhere in the fleet.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/addressing
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/how-it-works

**ID format.** Names (what you pass to `idFromName`) may contain ASCII letters, digits,
`-`, `_`, `.`, `:`, and spaces. Instance ids (what the platform addresses) are
`[A-Za-z0-9._-]` spans plus optional `:hex:` escape brackets (`:` URL-escapes to `%3A` on
the wire). `idFromName` does NOT escape — it passes the name through verbatim; to use
`:`/spaces, pre-encode with the Agent SDK's `encodeAgentName` (e.g.
`encodeAgentName("+15550100")` → `:2b:15550100`). A name of exactly `.` or `..` is
unaddressable (URL path resolution collapses those segments). Cap: 225 characters on the
**escaped id**. For phone numbers, strip the leading `+`.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/addressing
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace

**Where state lives.** Truth is `this.ctx.storage` (per-instance durable KV + embedded
SQLite). Instance fields (`this.x`) are a cache that vanishes on eviction/restart/relocation;
storage survives all of them and reloads on next activation. Instances are placed on first
touch, addressed by name forever after (never by location), kept warm while busy, evicted
when idle (scale-to-zero on Knative, like function containers), restarted on deploy or host
failure. An open WebSocket holds the instance resident; alarms also wake a sleeping
instance.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/lifecycle
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage

---

## 2. TypeScript API

**Import verified.** `import { StatefulActor } from "@telnyx/edge-runtime"` appears
verbatim on the main page, quick start, how-it-works, and API reference. The package also
exports types: `ActorContext`, `ActorStorage`, `ActorNamespace`, `ActorStub`,
`IdFromNameOptions`, `AlarmInfo`; and errors `BlockConcurrencyTimeoutError`,
`ActorOutputGateError`, `ActorMethodTimeoutError`, `ActorFetchTimeoutError`,
`CodecError`. Runtime `fetch(req, env)` gets `env` from `@telnyx/edge-runtime` (bindings
resolve on it).
https://developers.telnyx.com/docs/edge-compute/stateful-actors
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference
https://developers.telnyx.com/docs/edge-compute/runtime/bindings

**Project shape (two exports).** One module (the `main` in `telnyx.toml`) exports the
actor class (so it ships in the bundle) and a `default { fetch }` handler that calls the
actor through the binding. The exported class name must equal the `[[actors]]` `type`.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/project-structure
https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start

**Manifest binding.** `[[actors]]` in the umbrella `telnyx.toml` — confirmed; the
bindings page's catalogue marks it "umbrella `telnyx.toml` only" (not `func.toml`, which
holds the other binding kinds). Fields:

```toml
name = "account"              # function name
main = "src/index.ts"         # entry: fetch handler + class re-export
compatibility_date = "2026-05-01"

[[actors]]
binding = "ACCOUNT"           # the property on env
type    = "Account"           # the class to instantiate per name
# env_vars = { LOG_LEVEL = "debug" }   # optional, per actor type
[edge_compute]
func_id = "..."               # written by `telnyx-edge new-func`
func_name = "account"
```

Constraints enforced at ship time: `binding`/`type` must be identifiers without `__`;
`type` ≤ 32 chars and may not start with `telnyx` (reserved); binding names unique across
all bindings in the file; `SECRETS` reserved when `[[secrets]]` present; multiple
`[[actors]]` blocks allowed, including two bindings → same `type` if they declare the same
`env_vars`.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/configuration
https://developers.telnyx.com/docs/edge-compute/runtime/bindings

**Class API.**

- Constructor: you never `new` an actor — the runtime does. `StatefulActor<Env>` wires
  `this.ctx` and `this.env` in the base; omit the constructor unless you need one-shot
  init, in which case override it and use `ctx.blockConcurrencyWhile(async () => {...})`
  (30s budget; over-budget → `BlockConcurrencyTimeoutError`, activation torn down and
  retried on the next call). Other calls wait until the init resolves.
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/base
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/context
- `this.ctx` (`ActorContext`): `readonly id` (the name you passed to `idFromName`),
  `storage` (below), `blockConcurrencyWhile(fn)`, `setAlarm(when)` (alias of
  `storage.setAlarm`), `count()` (live WebSockets on this instance, sync), `broadcast(data)`
  (text or binary to every socket on this instance, returns count).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/context
- `this.ctx.storage` (`ActorStorage`):
  ```ts
  get<T>(key): Promise<T | undefined>;
  put<T>(key, value): Promise<void>;
  delete(key): Promise<boolean>;              // true iff key existed
  list<T>(options?): Promise<Map<string, T>>; // lexicographic; prefix/start/startAfter/end/reverse/limit (default 128, max 1000)
  deleteAll(): Promise<void>;                 // does NOT clear a pending alarm
  transaction<T>(fn: (txn: StorageTransaction) => Promise<T>): Promise<T>; // atomic multi-key
  readonly sql: SqlStorage;                   // embedded SQLite, synchronous exec()
  transactionSync<T>(fn: () => T): T;         // atomic SQL tx; fn must NOT be async
  setAlarm(when: number) | getAlarm(): Promise<number | null> | deleteAlarm()
  ```
  Codec: JSON natives plus `Date`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `BigInt`,
  `RegExp` round-trip; functions, class instances, circular structures, promises, streams
  rejected at write with `CodecError`. Keys prefixed `__telnyx_` reserved. Lazy per-`get`
  (no preload on activation). Read-your-writes.
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
- Method dispatch rules: public methods are RPC-callable from a stub (declare `async`);
  `_`-prefixed methods are internal and rejected by the runtime; TypeScript `private` is
  erased and does NOT stop remote calls — `_` is the only opt-out. `fetch(req)`,
  `alarm(info)`, `webSocket(ws, req)`, the constructor, and base-class methods are special,
  not auto-RPC. Methods run under a 30s wall-clock budget; over-budget →
  `ActorMethodTimeoutError` (invocation fails; instance survives).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/base
- Optional handlers: `fetch(req): Promise<Response>` (default 404; reachable as
  `stub.fetch(req)`), `alarm(info)` (default no-op), `webSocket(ws, req)` (no default —
  declaring it is the whole opt-in; upgrade routed at an actor without it closes `1011`).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/base

**Invocation (RPC stub shape).** From the function:

```ts
const stub = env.ACCOUNT.idFromName("acct_123");
const result = await stub.debit(30);        // RPC; queued at the one instance
```

`ActorStub` = `{ readonly id: string; fetch(req): Promise<Response> }` plus your public
methods (dispatch via runtime Proxy). Typing: `telnyx-edge types` generates
`telnyx-env.d.ts` typing each binding against the class's public methods, or hand-roll:

```ts
type AccountStub = ActorStub & Pick<Account, "deposit" | "debit" | "balance">;
interface AccountNamespace extends ActorNamespace {
  idFromName(name: string, options?: IdFromNameOptions): AccountStub;
}
interface Env { ACCOUNT: AccountNamespace }
```

`IdFromNameOptions` = `{ locationHint?: "us-east" | "us-west" | "eu" | "apac" }` — a
first-touch-only placement hint, currently ignored by the platform (accepted and reserved).
Hand-rolling is also the path for shared-actor reference functions (which ship no class for
codegen to read).
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/stub
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace

**Caller-side errors:** failed stub calls reject with `Error` subclasses distinguished by
`err.name` — `ActorMethodError` (your method threw, message preserved),
`ActorPrivateMethodError`, `ActorUnknownMethodError`.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/errors

---

## 3. Read-modify-write semantics

**Two concurrent calls to the same actor:** serialized. "single-threaded dispatch. No
locks, no races inside an instance" and the quick start's debit: "concurrent debits on the
same account serialize automatically. No lock, no race: two debits can't both pass the
balance check." The check-then-act in the docs' `debit` (read balance → test → write) is
safe purely because of per-instance serialization — the docs frame that property as "the
whole product."
https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/execution-model
https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start

**Atomicity:**

- Per-key write durability: "Durable before reply" — the runtime holds the method's result
  until every write it issued has been flushed; if a write rejects after the method
  returned, the call fails with `ActorOutputGateError` instead of returning success.
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/execution-model
- Turn-level atomicity (stronger than expected): "A turn that returns successfully is
  persisted — all writes made during the turn (put/delete/transaction/sql.exec/setAlarm)
  commit atomically at end-of-turn; a turn that throws commits nothing."
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
- Multi-key: `transaction(fn)` = atomic all-or-nothing across keys — but a thrown
  transaction also poisons the whole method call with `ActorOutputGateError` even if
  caught; only the transaction's own writes are undone; later writes still commit but the
  caller sees the error. Not a "try the write, continue on failure" tool.
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
- Cross-actor: none. "there is no transaction across two actors, and there's no JOIN
  across them." Each instance is its own consistency domain; use a real DB for cross-entity
  transactions. https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/when-to-use

**Storage size limits.** Documented: `list` limit default 128 / max 1000 per call; SQL
database 1 GB per actor; 2 MiB per SQL bound value; 32,766 bound parameters per statement.
**NOT documented anywhere I could find (including the llms.txt index — there is no separate
limits page): a per-key value size cap or a total per-actor KV storage cap.** The
observability metrics track "stored state size" per type, implying the platform measures
it, but no number is published. Open question below.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/storage/sql
https://developers.telnyx.com/docs/edge-compute/stateful-actors/observability

---

## 4. Scheduled work

**Alarms exist — first-class.** Every actor has a **single per-instance alarm**:

| What | API |
| - | - |
| Set/replace | `await this.ctx.storage.setAlarm(when)` — ms since epoch (not seconds) |
| Read | `await this.ctx.storage.getAlarm()` → `number \| null` |
| Clear | `await this.ctx.storage.deleteAlarm()` |
| Alias | `await this.ctx.setAlarm(when)` |
| Handle | override `async alarm(info: AlarmInfo)` — `info.retryCount`, `info.isRetry` |

https://developers.telnyx.com/docs/edge-compute/stateful-actors/alarms

- Delivery: **at-least-once**; a failed run is redelivered 3×, ~1 s apart (4 attempts
  total), then the alarm is **deleted** with no signal — so don't use `throw` as the retry
  mechanism; catch, record, re-arm at your own backoff. Alarm handler runs under the same
  single-threaded dispatch as other methods but with a **15-minute** budget (vs 30 s for
  methods). Firing precision ~1 s; no recurring flag — re-arm from inside `alarm()`;
  `deleteAll()` does not clear the alarm (decommission: `deleteAlarm()` then
  `deleteAll()`). One alarm per instance — for multiple timers keep a queue in storage and
  drive it from the single alarm. Documented patterns: TTL/expiry, retry backoff, session
  timeout (touch pushes the alarm out), coalesced drain (set on first write, drain on fire).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/alarms
- Alarms wake a scaled-to-zero instance (the one trigger besides requests).
  https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/lifecycle

So no lazy-expiry-on-read workaround is needed — TTL via alarm is the documented pattern
(still, "check the row is still expired before deleting" because of at-least-once).

**WebSockets on actors — yes, in beta.** Any actor class can terminate a WebSocket by
declaring `async webSocket(ws, req)`. Split: the function runs once at the handshake
(auth, rate-limit, pick the actor, forward via
`env.ROOM.idFromName(name).fetch(new Request(req, { headers }))`), then the actor owns the
live socket — each inbound frame dispatches like a method call, serialized with RPCs and
alarms. `ws` has Node `ws` semantics (`ws.on("message", (data, isBinary) => ...)`,
`ws.send`, `ws.close`) — not Cloudflare's `WebSocketPair`. `ctx.count()` / `ctx.broadcast()`
are instance-scoped. Push without an inbound frame: alarm + `ctx.broadcast()`. Outbound
`fetch` and a WebSocket client both work from inside a handler. Limits: 1 MiB inbound
frame (`1009`), 256 events / 1 MiB queue overflow (`1013`), 30 s per-message budget
(`1011`), 1-hour connection duration today (`1006`), no platform cap on outbound frames;
`ws.send()` is immediate and NOT held for durability (frame-vs-commit mismatch is the
caller's problem; make frames re-derivable from storage). Cross-site: sockets reach the
actor's home from any site the function is deployed to.
https://developers.telnyx.com/docs/edge-compute/stateful-actors/websockets
https://developers.telnyx.com/docs/edge-compute/stateful-actors/websockets/lifecycle

---

## 5. Shared actors

**Yes — same account only.** One Stateful Actor type is reachable from multiple Edge
Compute functions on the same account: the function that ships the class **owns** the
actor; reference functions declare the **same `type`** under their **own `binding`** and
ship **no class** — their binding routes to the owner's actor and state; no second
instance is created. Writes through one binding are visible to reads through the other.
Rules: same account, same `type` (an unmatched type won't resolve); only one function owns
the class; each function picks its own binding name; keep reference bundles class-free
(don't import the owner's class — the bundler roots at `main`, so class-free is what makes
it reference-only).
https://developers.telnyx.com/docs/edge-compute/stateful-actors/shared-actors

Use cases per the docs: split read/write paths with separate auth/rate-limits/deploy
cadence; let a second function call into a domain the first owns (e.g. reporting reads an
account actor that payments owns); one durable actor behind many entrypoints.

---

## 6. DevEx friction (explicit, for the platform DevEx review)

1. **`newUniqueId()` is broken on the platform** — documented as "currently fails at call
   time (a known runtime issue)"; docs tell you to mint an identity yourself and pass it
   to `idFromName`. A documented-not-working core API.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace
2. **Name/ID escaping is a foot-garden.** `idFromName` does not escape `:` or spaces; you
   must reach for the Agent SDK's `encodeAgentName` (not part of edge-runtime). The 225-char
   cap applies to the *escaped* id, and it is **not enforced on direct `idFromName` calls**:
   an over-limit instance activates, accepts writes, and only becomes unreachable after its
   first eviction — a silent state-loss failure mode you must pre-validate yourself.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/concepts/addressing
3. **CLI version traps.** `telnyx-edge` ≤ v0.2.2: `new-func --actor` "appears to work, but
   `ship` fails". Actor observability commands need v0.5.8+; `telnyx-edge types` for KV
   bindings needs v0.2.3+. Version sensitivity is scattered across pages, not centralized.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/quick-start
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/observability
   https://developers.telnyx.com/docs/edge-compute/runtime/bindings
4. **`private` doesn't mean private.** TypeScript's `private` is erased; only the `_` name
   prefix stops RPC. A natural looking-lockdown keyword silently fails to protect state.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/base
5. **Thrown `transaction()` poisons the whole turn.** Even if you catch it, the caller gets
   `ActorOutputGateError` instead of your return value, and it is explicitly "not a
   control-flow tool". Surprising asymmetry: `transactionSync` (SQL) does NOT poison the
   turn when caught.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
6. **Silent alarm death.** After 4 failed attempts the alarm is deleted with "no signal
   when that happens" — a scheduled job can just vanish. Docs tell you to never rely on
   the built-in retries for anything that must happen.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/alarms
7. **`deleteAll()` doesn't clear the alarm** — decommissioning an actor incorrectly leaves
   a re-arming alarm running against empty state.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/alarms
8. **Shared-actor scaffolding is manual.** No `new-func` flag for reference-only; the
   documented recipe is scaffold-with-`--actor`, `rm src/counter.ts`, rename binding —
   an undocumented-looking dance that leaves a misleading `[[actors]]` owner-style manifest.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/shared-actors
9. **KV value-size limits undocumented.** `list` limits and SQL limits are documented; no
   per-key value cap or total KV storage cap is published for `ctx.storage` (only a
   "stored state size" metric exists). See Open questions.
   https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/storage
10. **TypeScript-only.** No REST fallback for actors at all (unlike KV, secrets, SQL DBs).
    `env`/`telnyx-edge types` is TS-only.
    https://developers.telnyx.com/docs/edge-compute/runtime/bindings
11. **WebSocket beta edges:** connection budget (1 h today) is **stamped at function-deploy
    time** — a function deployed under the earlier ~5-min limit keeps the shorter budget
    until next deploy; actor names and forwarded header values must be printable ASCII
    today; `locationHint` is accepted but ignored; actor-side restart closes `1001` while
    function redeploys sever with `1006`.
    https://developers.telnyx.com/docs/edge-compute/stateful-actors/websockets/lifecycle
    https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace
12. **Env-var layering for actors** (`[env_vars.shared]` → `[env_vars.actor]` → per-type
    `env_vars`, later wins; keys directly under `[env_vars]` reach the function, NOT
    actors) is subtle and easy to misread; 50-variable cap per actor type.
    https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/configuration
13. **SQL tokenizer best-effort**: multi-statement `exec` splitting is a TS tokenizer, not
    SQLite parsing; unquoted reserved-word identifiers can confuse it (tracked as
    COMPUTE-470). Integers > 2^53 read back as `RangeError` (loud, but a trap).
    https://developers.telnyx.com/docs/edge-compute/stateful-actors/guides/storage/sql
14. **Observability is CLI-pull, not push**: actor logs are read-only fixed-window reports,
    not live streams; no webhook/log-drain surface mentioned on the actor pages.
    https://developers.telnyx.com/docs/edge-compute/stateful-actors/observability

---

## Gotchas (cross-cutting, beyond the numbered friction list)

- Beta status is explicit on the main page, WebSockets, and the SQL guide (`ctx.storage.sql`
  needs `@telnyx/edge-runtime` ≥ 0.6.0; `transactionSync` type needs 0.8.0 — "use the
  latest SDK").
- Turn-atomic writes mean a method that throws rolls back ALL its writes, not just the
  failed one — free transactionality, but also a way to lose intended writes by accident.
- `getAlarm()`/alarm semantics: `when` is ms since epoch; sub-second scheduling isn't
  supported (~1 s precision).
- Codec: `Date`, `Map`, `Set`, typed arrays, `ArrayBuffer`, `BigInt`, `RegExp` survive;
  class instances do NOT (rejected) — design return values/args as plain data.
- `stub.id` is the *name* passed to `idFromName`, not a platform-internal id.
- Health-endpoint convention (`/health/liveness`, `/health/readiness`) appears in the
  quick start but isn't defined as a platform requirement on any fetched page.
- Cross-site RPC just works ("the platform routes the call to the actor's home") — no
  per-region plumbing needed for multi-site deployments.

## Open questions

1. **KV value-size / total-storage cap for `ctx.storage`** — not documented anywhere
   fetched. Could ask Telnyx or test empirically (write big keys, watch `actors metrics`
   "stored state size").
2. **Where does actor state physically live** — which region/persistence layer backs
   `ctx.storage` (the lifecycle page says only "durable"); no data-residency statement
   found. Matters for compliance-sensitive apps.
3. **Does `idFromName` cost anything on miss** — cold-start economics are mentioned
   (pod boot + activation) but no latency numbers for actor cold start vs function cold
   start.
4. **Rate limits on actor RPC calls** — none documented on any fetched page; the
   rate-limiting binding exists for functions, but no documented per-actor call quota.
5. **`telnyx-edge dev` local behavior** for actors (the configuration page references it
   for env vars) — local fidelity of alarms/storage/sql unverified; not fetched.
6. **Billing** — "active seconds only" is stated for scale-to-zero, but no actor-specific
   pricing table was fetched (out of scope for this research task).
