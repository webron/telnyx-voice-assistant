# Edge Compute — research synthesis

Distilled from `docs/inbox/{edge-functions,kv,actors}.md` (full detail + per-claim
URLs live there). Researched 2026-11-09 against live docs. CLI docs version v0.5.14,
latest release v0.5.17.

## Edge Functions

- **Not a V8 isolate.** A Linux container running an ordinary HTTP server
  (`node:http` on `PORT`, TS/JS; platform-run handler for Go/Python/Quarkus).
  HTTP is the only trigger — no cron, no queues.
- **TS toolchain:** `new-func -l ts` scaffolds a real TS project (`func.toml`,
  `index.ts`, `package.json`, `tsconfig.json`). Umbrella `telnyx.toml` projects
  (required for actors) bundle client-side with esbuild. Whether classic
  `func.toml` TS compiles server-side or runs natively is undocumented.
- **Limits:** request timeout 30 s default / **60 s hard max** (504 after);
  memory 128 MB (256 max); request/response bodies 10 MB; code 50 MB;
  60 deploys/hour; 100 functions/org. No concurrency knob.
- **Streaming verdict (D1):** plain functions are request/response. Bodies pass
  through raw, but nothing outlives the request. **SSE: not supported.**
  WebSockets: only via Stateful Actors (beta, 1 h cap). A per-request
  POST→JSON response pattern works fine within 30 s.
- **Pricing:** 3.6 M requests + 36 M CPU-ms/month free; then $0.21/M + $0.014/M.
  Idle time and deploys are free. Comfortably covers a demo week.

## `telnyx-edge` CLI

- **macOS arm64:** releases at github.com/team-telnyx/edge-compute/releases
  (v0.5.17 has `telnyx-edge-v0.5.17-macos-arm64.tar.gz` + SHA256SUMS). Not on
  npm/brew; un-versioned `releases/latest/download/...` URLs 404 — resolve the
  version-stamped asset. `telnyx-edge update` exists from v0.5.13.
- **Auth:** `telnyx-edge auth login` (browser OAuth) or `auth api-key set <KEY>`;
  persists to `~/.telnyx-edge/config.toml`. **Ignores `TELNYX_API_KEY` env var.**
- **Scaffold:** `new-func -l ts` registers server-side (writes `func_id` into
  `func.toml`); `--actor` scaffolds umbrella `telnyx.toml` + sample actor.
  Rapid repeats 429.
- **`ship`:** upload→build→deploy→monitor (default 5 min); prints
  `https://{func-name}-{func-id-prefix}.telnyxcompute.com` (prefix = first 10
  chars of `func_id`). Immutable revisions; `revisions list`/`rollback`. No
  environment flag — staging = separate function.
- **Other:** `logs [--tail]`, `metrics`, `log-export` (OTLP push), `secrets`
  (org-scoped), `types` (regenerate `telnyx-env.d.ts` after manifest changes),
  `storage kv ...`, `actors list|inspect|logs|metrics`, `dev` (local Docker at
  `:8787`, platform bindings absent), `tunnel`.

## KV

- **Model:** single global store, quorum-committed writes, read-your-writes per
  location (brief cross-location staleness), **no transactions/CAS — last-write-
  wins**. Not for counters/locks/coordination; that's the Actor's job.
- **Binding (TS):** `func.toml [storage.kv.NAME]` → `env.NAME.get(key)` /
  `get<T>(key, {type:"json"})` / `put(key, value, {expirationTtl})` /
  `delete` (idempotent) / `list({prefix})` (names+metadata only). REST twin:
  `GET|PUT|DELETE /v2/storage/kvs/{id}/keys/{key}` (raw body values,
  `?ttl_secs=`), list under `/keys?prefix=&limit=&cursor=`.
- **TTL:** server-side, whole seconds (1–…), **slides on rewrite**, unreadable
  back. Binding quirk: fractional TTL floors; < 1 sends **no TTL silently**.
  Envelope pattern (`{value, expires_at}` + lazy delete) when expiry must be
  inspectable.
- **Limits:** values ≤ 1 MiB (413), keys ≤ 256 chars, charset `a-zA-Z0-9-_/.=`
  (**no colons**), list pages 1–1000. Fresh namespace is `pending` (~20 s worst)
  and 409s writes until provisioned. **No published QPS limit.**
- **Pricing:** free 10 M reads / 1 M writes+deletes+lists / 1 GB per month; then
  $0.35/M reads, $3.50/M writes (10× reads), $0.35/GB-month. Writes are the
  meter to watch — no hot loops.
- Assistants/workflows **cannot** read KV directly (absence of documentation) —
  access goes through our webhook/Edge Function/MCP tools.

## Stateful Actors (beta)

- **Model:** exactly one instance per `idFromName(name)` name, fleet-wide;
  one call at a time — `await` yields the thread but the next queued call starts
  only at method boundaries. Different names run in parallel. State truth is
  `ctx.storage` (durable KV + embedded SQLite); instance fields are a cache.
  Scale-to-zero; alarms wake instances; WebSocket connections keep them resident.
- **TS API (verified):** `import { StatefulActor } from "@telnyx/edge-runtime"`.
  Subclass with public async methods (auto-RPC; `_`-prefix opts out; TS
  `private` does **not**). `this.ctx.id | storage | blockConcurrencyWhile |
  setAlarm | count | broadcast`; `this.env` has bindings.
  Manifest: umbrella `telnyx.toml` `[[actors]] binding = "SHELTER" type =
  "Shelter"`; call via `env.SHELTER.idFromName("shelter-01").holdBed(...)`.
  Typed by `telnyx-edge types` or hand-rolled `ActorStub & Pick<Class, ...>`.
- **RMW guarantees:** concurrent calls to one actor serialize; check-then-act
  needs no lock (the docs' own `debit` example). Durable-before-reply, and
  **turn-atomic** — all writes in a method commit atomically; a throw commits
  nothing. No cross-actor transactions.
- **Alarms:** one per instance. `setAlarm(ms-since-epoch)` / `getAlarm` /
  `deleteAlarm`; override `async alarm(info)` (`info.retryCount`). At-least-once:
  4 attempts (~1 s apart), then **silently deleted** — catch and re-arm yourself.
  15-min handler budget. ~1 s precision; re-arm from inside `alarm()` (no
  recurring flag). `deleteAll()` doesn't clear the alarm. Hold-expiry via alarm
  is the documented pattern (still verify hold is still expired at fire time).
- **Shared actors:** yes — one owner function ships the class; reference
  functions declare the same `type` under their own binding, ship no class, and
  hit the same per-name state (same account only).
- **Limits:** method budget 30 s; type name ≤ 32 chars; list 128/1000; SQL 1 GB
  per actor. Per-key value cap / total KV cap: **undocumented** (test before
  large `put`s). Codec: plain data only (no class instances); `Date`, `Map`,
  `Set`, `BigInt`, `ArrayBuffer` OK.

## Observability

- **Two log streams:** `runtime` (stdout/stderr, `console.*`, exceptions) and
  `invocations` (one platform record per HTTP request: method/path/status/
  duration/sizes/region). `telnyx-edge logs <fn> --type ... --since/--last/--json`,
  clamp 24 h/250 lines; live tail via WebSocket; lines arrive a few seconds after
  writing. Actor logs: one line per method call.
- **Log export:** `telnyx-edge log-export set <fn> --endpoint <OTLP URL>` pushes
  logs in real time to Honeycomb/Datadog/own collector.
- **Metrics:** request count, 2xx/4xx/5xx rates, p50/p95/p99/avg latency, CPU,
  memory; actors add stored-state size. `telnyx-edge metrics <fn>`.
- **No platform trace IDs** — propagate `X-Request-ID` yourself (recommended by
  the docs) across Function → KV/Actor → MCP. Caller IP is not propagated.
- Health endpoints are app-level for TS (`/health`).

## Decisions this settles

- **D1 (MCP hosting):** host the MCP server **as an Edge Function**, streamable
  HTTP per-request mode (POST→JSON), every tool fast (< ~25 s). No SSE, no
  WebSocket transport. All-Telnyx stack stands.
- **D2 (actor scope):** **shelter-only actor** (one per shelter via
  `idFromName`), owning inventory + the caller→hold map; per-caller hold surfaced
  to the webhook via a KV read cache the actor writes (single writer), with the
  actor as source of truth. No per-caller actor.
- **DV timeout:** set `dynamic_variables_webhook_timeout_ms` to 8000 (docs
  recommend this for edge cold starts; default 1500 ms is too tight).
- **Webhook signature:** verify Ed25519 (`telnyx-signature-ed25519`,
  sign string `"{timestamp}|{body}"`, key from `GET /v2/public_key`).
- **Response shape:** DV webhook must nest under `{"dynamic_variables": {...}}`
  — flat responses are silently ignored.
- **Hold expiry:** actor alarm, not lazy expiry (the API exists); still verify
  hold state before freeing the bed (at-least-once delivery).

## Gotchas (architecture-shaping first)

1. 30 s/60 s request timeout shapes all tool and webhook design.
2. No cron triggers — scheduling is external or actor alarms.
3. `newUniqueId()` broken; use `idFromName` with self-minted ids.
4. `idFromName` doesn't escape names; 225-char escaped-id cap isn't enforced on
   write — over-long ids become unreachable only after eviction. Pre-validate.
5. KV: silent TTL loss (< 1 s post-floor), no CAS, last-write-wins, write-heavy
   billing.
6. KV namespace provisioning race (409 until ~provision_ok).
7. Alarms die silently after 4 failed attempts; re-arm in `alarm()`.
8. Turn-atomicity: a thrown method rolls back all its writes.
9. CLI ignores `TELNYX_API_KEY`; no env flag for staging; secrets are org-wide
   and injected into every function.
10. Log levels best-effort (wrong on stack traces); log reads lag a few seconds;
    `--tail` loses lines during reconnect gaps.
11. Docs quirks: quickstart URL placeholder contradicts routing docs; stale
    best-practices page claims no logs/metrics exist; brief's
    `/reference/logs-metrics` URL 404s (real: `/observability`); version-gated
    SDK features (expirationTtl ≥ 0.2.2, KV types ≥ 0.2.3, obs ≥ 0.5.2/0.5.8).

## Empirical tests to run early (live platform)

1. `new-func -l ts` scaffold + `ship`: does classic TS compile server-side; what
   Node version runs; cold-start latency for the DV webhook budget.
2. KV: TTL via binding (sub-second flooring), list shape, 409 provisioning.
3. Actors: method RMW race (two concurrent holds on the last bed — one must
   fail), alarm fire/precision/retries, storage size caps.
4. DV webhook end-to-end: signature verification, 8 s timeout headroom, flat vs
   nested response behavior.
5. Number → assistant binding (no documented API — Portal only?).
6. MCP server on the Edge Function reachable from an assistant (org-level MCP
   config + tool scoping), and tool failure semantics (what does the model see).
