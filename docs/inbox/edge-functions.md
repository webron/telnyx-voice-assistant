# Edge Functions runtime + `telnyx-edge` CLI + logs/metrics — research notes

Research date: 2026-11-09. Docs version observed: CLI reference documents **v0.5.14**; latest GitHub release is **v0.5.17** (2026-11-04).

---

## 1. Runtime: what it is, languages, TS handling, execution model, streaming/SSE

### What it is — NOT a V8 isolate

A Telnyx Edge Compute function is **a Linux container running an ordinary HTTP server**, deployed to Telnyx edge sites (in carrier facilities), served at a public URL. It is emphatically **not** a Cloudflare-Workers-style V8 isolate.

> "A **function** is the compute primitive of Telnyx Edge Compute: an ordinary HTTP server, packaged as a container, deployed to Telnyx's global edge network, and served at its own public URL." — https://developers.telnyx.com/docs/edge-compute/overview
>
> "An Edge Compute function is a Linux container running an HTTP server — one you run yourself in TypeScript and JavaScript, one run for you in Go, Python, and Java." — https://developers.telnyx.com/docs/edge-compute/runtime/execution-model

In TS/JS **you own and run the server** (`node:http` on `process.env.PORT || 8080`); in Go/Python/Java the platform runs the server and calls your handler. HTTP is the **only trigger** — no cron, no queues (source: execution-model, routing).

### Languages

`telnyx-edge new-func -l <lang>` scaffolds: `ts`, `js`, `go`, `python`, `java` (Quarkus). Contracts per language: `node:http` (TS/JS), Go `http.Handler`, Python ASGI, Quarkus Funqy. Source: https://developers.telnyx.com/docs/edge-compute/overview, https://developers.telnyx.com/docs/edge-compute/runtime/http-handler

The binding SDK (`@telnyx/edge-runtime` — typed `env`, actors, KV bindings) is **TypeScript-only**. Source: overview; bindings page.

### TypeScript handling

- `new-func -l ts` scaffolds `func.toml`, `index.ts` (project root, NOT `src/`), `package.json`, `tsconfig.json` — i.e., you get a real TS project with a compile step, not a raw file shipped as-is. Source: https://developers.telnyx.com/docs/edge-compute/reference/cli (new-func)
- For **umbrella projects** (`telnyx.toml` — required for actors), `ship` bundles client-side: "the module graph rooted at `main` is compiled into a single file with esbuild (TypeScript/JavaScript only)". Source: https://developers.telnyx.com/docs/edge-compute/reference/cli (ship)
- For classic `func.toml` TS projects, `ship` "uploads the project, builds it, pushes, and deploys" — the docs do not state whether `tsc` runs server-side or Node runs TS natively. **Undocumented — see Open questions.**

### Execution model: request/response, warm/cold, scale to zero

Source: https://developers.telnyx.com/docs/edge-compute/runtime/execution-model

- Container lifecycle: cold start → warm reuse → recycled without notice; **scale to zero** at idle; no concurrency knob (auto-scaled).
- Module-scope state persists per container but is **not durable** — two requests may or may not share a container.
- **Request timeout: 30 s default, 60 s maximum**, enforced by the platform (504 after). Not configurable in `func.toml` — "there is no `timeout_seconds` field". (Limits page: https://developers.telnyx.com/docs/edge-compute/platform/limits)
- Doc recommendation: set your own upstream timeout (e.g. `AbortSignal.timeout(25_000)`) under the platform budget.

### Hard limits (https://developers.telnyx.com/docs/edge-compute/platform/limits)

| Limit | Value |
|---|---|
| Request timeout | 30 s default / **60 s max** |
| Memory per container | 128 MB default (platform may raise to 256 MB) |
| Request body size | 10 MB |
| Response body size | 10 MB |
| Function code size | 50 MB compressed (incl. deps) |
| Env vars per function/actor type | 50 |
| Secret value size | 10 KB; 100 secrets per org |
| Outbound connections per request | 100 |
| DNS resolution timeout | 5 s |
| Deployments per hour | 60 |
| API requests per minute | 1,000 |
| Concurrent invocations | no hard cap (auto-scale) |
| Functions per org | 100 |

Error mapping: 504 timeout, 500 memory-kill, 413 payload, 429 rate-limited.

### Streaming / SSE / WebSockets — the critical question for MCP hosting

- **Plain functions: no documented SSE support and no documented WebSocket support.** Nothing in the runtime, HTTP-handler, limits, or observability pages mentions Server-Sent Events. Grep of the full compute doc bundle (`compute-full.txt`) for "SSE / server-sent / long-lived" returns nothing for functions.
- **Streaming through a function is possible as ordinary HTTP** — bodies pass through raw both ways, headers are yours, and the limits page explicitly says "Stream large payloads instead of buffering them" (memory section). Node's `res.write()` chunking therefore works — but **everything is bounded by the 30 s/60 s request timeout**. A connection cannot outlive its HTTP request.
- **WebSockets exist only on Stateful Actors (beta)** — a plain function only performs the handshake and forwards; the actor owns the live socket (`webSocket(ws, req)` method; Node `ws`-like semantics; `ctx.broadcast()`). Source: https://developers.telnyx.com/docs/edge-compute/stateful-actors/websockets
  - Connection budget: **max 1 hour (3,600 s) from handshake**, even while active; cut as close code 1006. The budget is stamped at deploy — functions last deployed when the earlier ~5-minute limit was in effect keep the shorter budget until the next deploy.
  - Per-message handler budget: the 30 s request budget applies to each frame handler; overflow queue = 256 events or 1 MiB → close 1013; single frame > 1 MiB → close 1009.
  - `ws.send()` is immediate and NOT held for durability (a method's return is durable-before-reply, a sent frame is not).

**Verdict for hosting an MCP server as an Edge Function:**

- **Streamable-HTTP transport, per-request mode: YES.** The function is just an HTTP server; each MCP POST → single JSON response works cleanly within the 30 s window. This is the practical shape: tools must complete (or checkpoint) inside ~30 s, ideally well under. 10 MB body cap is generous for JSON-RPC.
- **Long-lived SSE: NO for plain functions.** MCP streamable-HTTP's SSE stream for server-initiated messages (and any long-lived GET SSE stream) would be terminated at 60 s max. There is no keep-alive/streaming allowance. An MCP client relying on a persistent GET SSE stream will see disconnects.
- **WebSocket transport: only on an actor (beta), 1 h cap.** An actor could terminate MCP-over-WebSocket, but WebSocket MCP transport is not the current spec-recommended transport, and per-frame 30 s budget complicates long tool calls.
- Long-running tool calls (> 60 s) are not supportable synchronously in any mode — design tools to return fast or poll.

---

## 2. `telnyx-edge` CLI

### Releases & macOS install

- Releases: https://github.com/team-telnyx/edge-compute/releases — verified via GitHub API: latest **v0.5.17** (published 2026-11-04), assets include `telnyx-edge-v0.5.17-macos-arm64.tar.gz` (~6.3 MB) **plus macos-amd64, linux amd64/arm64, windows amd64/arm64, and a SHA256SUMS file**. Confirmed macOS (Apple silicon) build exists.
- Docs CLI version: reference page documents v0.5.14; docs lag the releases slightly.
- Install (macOS Apple silicon) — https://developers.telnyx.com/docs/edge-compute/quickstart §1:
  ```bash
  VERSION=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/team-telnyx/edge-compute/releases/latest | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+$') &&
  curl -fsSL "https://github.com/team-telnyx/edge-compute/releases/download/${VERSION}/telnyx-edge-${VERSION}-macos-arm64.tar.gz" | tar xz &&
  sudo mv "telnyx-edge-${VERSION}-macos-arm64/telnyx-edge" /usr/local/bin/
  telnyx-edge --version
  ```
- **Not on npm, no Homebrew formula** — GitHub release binaries only (CLI reference, Installation). No un-versioned "latest" asset: `releases/latest/download/...` returns 404 (deploy page states this explicitly — gotcha for CI).
- Upgrade: `telnyx-edge update` (v0.5.13+; `sudo` if in `/usr/local/bin`). Older installs must re-install manually once.

### Auth

- `telnyx-edge auth login` (OAuth in browser) or `telnyx-edge auth api-key set <KEY>`; verify with `auth status`. Credentials persist to `~/.telnyx-edge/config.toml`. **The CLI does NOT read `TELNYX_API_KEY` env var** — in CI, run `auth api-key set` as a setup step (quickstart §2).

### `new-func`

- `telnyx-edge new-func -l ts -n hello` → registers the function **server-side** (writes the assigned UUID `func_id` into `func.toml`) and scaffolds:
  | Language | Files |
  |---|---|
  | ts | `func.toml`, `index.ts`, `package.json`, `tsconfig.json` |
  | js | `func.toml`, `index.js`, `package.json` |
  | go | `func.toml`, `handler.go`, `go.mod` |
  | python | `func.toml`, `function/func.py`, `pyproject.toml` |
  | quarkus | `func.toml`, `pom.xml`, `mvnw`, `.mvn/`, `src/main/java/functions/` |
  - Rapid successive calls hit HTTP 429 (server-side registration is rate-limited).
  - `new-func --actor` scaffolds an umbrella `telnyx.toml` with `[[actors]]`, a sample actor class, and a fetch handler; requires CLI > v0.2.2 (older CLIs "appear to work but ship fails").

### `ship`

- `telnyx-edge ship` (flags: `-f/--from-dir`, `-t/--timeout` default `5m0s`) uploads, builds, pushes, deploys, and monitors the rollout. Prints the live URL.
- URL format: **`https://{func-name}-{func-id-prefix}.telnyxcompute.com`** where the prefix is the first 10 chars of the function's `func_id` — e.g. `https://demo-0198c2c5-8.telnyxcompute.com`. Source: https://developers.telnyx.com/docs/edge-compute/configuration/routing. (The quickstart example `hello-<org>.telnyxcompute.com` is misleading — see Gotchas.)
- Every successful ship → immutable revision; `revisions list` + `rollback` to retarget traffic instantly (only revisions that reached `deploy_ok`).
- **No environment flag** — staging/production are separate functions (different `func.toml` with different `func_id`); see deploy guide.
- Umbrella projects bundled client-side with esbuild before upload.

### Other commands that matter (all in CLI reference v0.5.14)

- `ship status <fn> [--logs]` — latest ship outcome + failure stage/reason + platform snippet.
- `logs <fn>` — see §4. `log-export` — OTLP push export.
- `metrics <fn>` — request/latency/CPU/memory aggregates.
- `secrets add|list|delete` — **org-scoped** secrets; injected as env vars into all org functions; values never shown; redeploy after change.
- `bindings create|get|validate|update|delete` — manages the **org-level** Telnyx API credential behind `[telnyx]` (one per org; per-function flow needs none of this).
- `types` — regenerates `telnyx-env.d.ts` from the manifest (re-run after every binding change).
- `storage kv create/list/get/delete`, `storage kv key put/get/list/delete` (`--ttl 30s`); `storage sqldb ...` (CLI ≥ 0.3.0).
- `actors list|inspect|instances|logs|metrics|delete`.
- `dev` — runs a `telnyx.toml` project locally in Docker at `http://127.0.0.1:8787`, hot reload; needs Docker Compose v2.17+, ~1 GB of images. Platform bindings (secrets, `[telnyx]`, `[storage.*]`, `[[ratelimits]]`) are NOT available locally.
- `domains` (custom domains, customer-provided TLS), `tunnel` + `network route` (v0.5.14+), `deployments`, `reset-func` (only from terminal failure states), `delete-func`, `config`, `status` (self-diagnostics).
- Related docs: https://developers.telnyx.com/docs/edge-compute/configuration (manifest reference).

---

## 3. Bindings: KV + Actors on `env`, REST paths

Declared in the manifest (func.toml or telnyx.toml); resolved at runtime onto `env` from `@telnyx/edge-runtime`. Source: https://developers.telnyx.com/docs/edge-compute/runtime/bindings, https://developers.telnyx.com/docs/edge-compute/configuration

### KV

```toml
[storage.kv.MY_KV]
id = "<kv-namespace-uuid>"   # from `telnyx-edge storage kv create`
```
```ts
import { env } from "@telnyx/edge-runtime";
await env.MY_KV.put("user/123", JSON.stringify({...}), { expirationTtl: 60 });
const v  = await env.MY_KV.get("user/123");                       // string | null
const j  = await env.MY_KV.get<{...}>("user/123", { type: "json" });
await env.MY_KV.delete("user/123");                               // idempotent
const l  = await env.MY_KV.list({ prefix: "user/" });             // names + metadata, paginated by cursor
```
- Surface: `get` / `put` / `delete` / `list` on a `KvNamespace`. KV type generation requires CLI ≥ v0.2.3; `expirationTtl` requires `@telnyx/edge-runtime` ≥ 0.2.2 (silently ignored before); `metadata` option is deprecated/ignored everywhere. Sources: KV quick start, KV page.
- REST path (any language / outside the platform): `GET|PUT|DELETE https://api.telnyx.com/v2/storage/kvs/{id}/keys/{key}` with `Authorization: Bearer $TELNYX_API_KEY`; value is the raw body (no envelope/base64). `?ttl_secs=N` for TTL. List: `GET .../keys?prefix=&limit=` + `meta.cursor` pagination. Both paths hit the same store. Source: https://developers.telnyx.com/docs/edge-compute/kv/quick-start

### Stateful Actors

```toml
# telnyx.toml (umbrella manifest — actors CANNOT be declared in classic func.toml)
name = "account"
main = "src/index.ts"
[[actors]]
binding = "ACCOUNT"   # → env.ACCOUNT
type    = "Account"   # exported class
```
```ts
const stub = env.ACCOUNT.idFromName("acct_123");
const res  = await stub.debit(30);          // RPC to the one owner of "acct_123"
```
- `env.<BINDING>` is an `ActorNamespace`: `idFromName(name, {locationHint?})` → deterministic per-name instance; `newUniqueId()` → random id (**currently broken — fails at call time; known runtime issue: mint your own id and use `idFromName`**). Source: https://developers.telnyx.com/docs/edge-compute/stateful-actors/api-reference/namespace
- Stub = `ActorStub` (`.id`, `.fetch(req)`) + the class's public methods, typed by `telnyx-edge types` or hand-rolled (`type AccountStub = ActorStub & Pick<Account, ...>`).
- Guarantees: one instance per name; one call at a time (single-threaded dispatch); method return ⇒ writes flushed (durable-before-reply); memory is a cache — only `ctx.storage` survives restarts. Sources: stateful-actors, concepts/how-it-works.
- `this.ctx.storage` is per-instance durable storage with `get`/`put`/`delete`, plus **`setAlarm`/`getAlarm`/`deleteAlarm`** (single one-shot alarm per instance; `alarm()` handler; at-least-once) — and `ctx.storage.sql` (SQLite) per the actors metrics docs.
- **TypeScript-only — there is no REST fallback for actors today** (bindings page states this explicitly). Non-TS runtimes cannot use actors at all.
- Actor names: ASCII letters/digits/`-`/`_`/`.`/`:`/spaces; instance ids are `[A-Za-z0-9._-]` + `:hex:` escapes; **`idFromName` does NOT escape** — 225-char cap on the *escaped* id; over-long ids silently become unreachable after eviction; `.`/`..` not addressable.

### Other bindings (catalogue, bindings page)

- `[telnyx]` → `env.<BINDING>` pre-authenticated Telnyx SDK client; also injects `TELNYX_API_KEY` env var into the container (how non-TS runtimes authenticate). Source: https://developers.telnyx.com/docs/edge-compute/telnyx-api
- `[[secrets]]` → `env.SECRETS.get("<handle>")` → `Promise<string>`; also injected as plain env var into all org functions.
- `[storage.cloudstorage.<NAME>]` (S3-compatible buckets), `[storage.sqldb.<NAME>]` (SQLite-style SQL DB, Beta), `[[ratelimits]]` (`env.<NAME>.limit({key})`, period 10 or 60 s only), `[network.<name>]` (WireGuard private networking).
- `telnyx-edge types` writes `telnyx-env.d.ts`; re-run after every manifest change. Stale `.d.ts` does not affect the deployed function (bindings resolve at runtime from the manifest).

---

## 4. Observability: logs, metrics, traces

Source: https://developers.telnyx.com/docs/edge-compute/observability and /observability/logs, /observability/metrics, /observability/api-reference.

- **Two log types**, same CLI command + API endpoint:
  - `runtime` — your function's stdout/stderr, including `console.log`, `console.error`, uncaught exceptions.
  - `invocations` — one platform-generated record per HTTP request (timestamp, method, path, status, duration, request/response size, serving region when available) — recorded even when the function logs nothing.
- CLI: `telnyx-edge logs my-func --type runtime|invocations --since 10m --last 200 --json` (window default 1 h, max 24 h; lines default 50, max 250; values are **clamped**, not refused). Requires CLI ≥ v0.5.1. Lines print `[timestamp] [level] message`, oldest first. **Level is best-effort and frequently wrong on stack traces** (multi-line errors arrive as separate lines). Lines reach the platform a few seconds after writing — make a request, wait, then read.
- **Live tail**: `telnyx-edge logs my-func --tail` (CLI ≥ v0.5.3) — streams over a WebSocket from the ingest pipeline; no history; in tail mode an unset `--type` shows both streams interleaved (different semantics from history mode). Auto-reconnects with backoff. (Actor-side tail: sessions severed roughly every 10 min by the API edge proxy; lines emitted during the gap are **lost**.)
- **Log export** (CLI ≥ v0.5.3): `telnyx-edge log-export set <fn> --endpoint <OTLP/HTTPS URL> [--header k=v ...] [--runtime|--invocations]` — pushes runtime and/or invocation logs **as they happen** to any OTLP-compatible destination (Honeycomb, Datadog, Grafana, own collector). One destination per function; `set` is a full replace.
- **Metrics** (CLI ≥ v0.5.2): `telnyx-edge metrics <fn> [--since 1h --errors --json]` — request count, 2xx/4xx/5xx rates, p50/p95/p99/avg latency, CPU, memory. Default 24 h, max 168 h. API: `GET /v2/compute/funcs/{id}/metric_aggregates` (requires start_time/end_time; supports edge-site and namespace filters).
- **Actor observability** (CLI ≥ v0.5.8): `telnyx-edge actors logs <Type> [--type runtime|invocations] [--instance x] [--tail]` and `actors metrics <Type>` — request count, success/error rates, latency percentiles, avg req/resp bytes, CPU, memory, **stored state size** (`ctx.storage.sql` across instances). Actor invocation logs record one line per method call (RPC, `fetch()`, `alarm()`).
- **Deployment history**: `ship status <fn>` (stage + reason + optional snippet; stages: build, deploy, platform, pre_build, security_review), `deployments <fn>`. APIs: `GET /v2/compute/funcs/{id}/logs`, `/metric_aggregates`, `/revisions`, `/ship_inspection`.
- **No built-in trace IDs.** The platform propagates nothing to correlate requests; the best-practices page recommends propagating `X-Request-ID` yourself (read it or generate it, return it, attach it to every event you emit). Also: caller IP is **not** propagated (`x-forwarded-for`/`x-real-ip` carry platform-internal values).
- Health checks are application-level: TS/JS functions must implement `/health` (+ subtree) themselves and keep it dependency-free; Go/Python/Java get probes handled by the platform (Quarkus: SmallRye `/health/*`).
- Portal/API usage of logs is CLI/API-only per the docs — the observability story is entirely `telnyx-edge` + the four `/v2/compute/funcs/{id}/...` endpoints, plus optional OTLP export.

---

## 5. Pricing / limits (one week on limited credit)

Source: https://developers.telnyx.com/docs/edge-compute/platform/pricing and https://developers.telnyx.com/docs/edge-compute/kv/pricing.

### Functions (two meters only; no charge for deploys, function count, or idle time)

| Resource | Free tier | Paid |
|---|---|---|
| Requests | 3.6 M/month | $0.21/M |
| CPU time | 36 M CPU-ms/month | $0.014/M CPU-ms |

The free tier is generous for a demo week: 3.6 M requests and 36,000 CPU-seconds comfortably cover development + demo traffic. Watch CPU: per-request CPU ms on Node with `@telnyx/edge-runtime` is small, but repeated KV-bound round trips don't burn CPU — parsing/crypto does.

### KV

| Resource | Free tier | Paid |
|---|---|---|
| Reads | 10 M/month | $0.35/M |
| Writes | 1 M/month | $3.50/M |
| Deletes | 1 M/month | $3.50/M |
| Lists | 1 M/month | $3.50/M |
| Storage | 1 GB/month | $0.35/GB-month |

Egress is free. Writes are 10× reads — don't write per-request hot loops; cache with TTL.

### KV limits (limits page)

Key ≤ 256 chars from `a-zA-Z0-9-_/.=` (no colons); value ≤ 1 MiB (413 over); TTL whole seconds, min 1.

### Stateful Actors

- **No separate published pricing** — the pricing page lists only functions (requests, CPU) and KV. Actors presumably meter through the same function meters, but this is undocumented (open question).
- Actor limits: type names ≤ 32 chars (configuration reference); 1 alarm per instance; the container-level limits (30/60 s, 128–256 MB) apply to method calls.

---

## 6. Gotchas and DevEx friction

**Architecture-shaping:**
1. **Not V8 isolates — containers with cold starts.** "Edge" evokes Cloudflare Workers; the reality is containers, scale-to-zero, and cold-start latency on spikes. No concurrency knob.
2. **30 s default / 60 s max request timeout, unconfigurable.** Directly constrains an MCP server hosted as an Edge Function: fine for per-request streamable-HTTP tool calls, fatal for long-lived SSE or > 60 s tool executions.
3. **SSE undocumented; WebSockets only on Stateful Actors (beta), 1 h cap.** If the architecture needs push/long-lived connections, the only first-class path is an actor WebSocket.
4. **Actors are TypeScript-only — no REST fallback.** Non-TS functions can't use the product at all. Also: actors require the umbrella `telnyx.toml` (not `func.toml`).
5. **`newUniqueId()` is broken** (documented known issue — fails at call time). Use `idFromName` with self-minted ids.
6. **Actor WebSocket budget stamped at deploy:** a function deployed when the ~5-minute connection cap was in effect keeps the short cap until its next deploy — silent versioning weirdness.
7. **`idFromName` does not escape names; 225-char escaped-id limit**; over-long ids are accepted, write, and only become unreachable after eviction — no early error.
8. **No cron triggers.** Scheduling must be external (GitHub Actions cron) or actor alarms.

**Docs/CLI friction:**
9. **Quickstart URL placeholder contradicts routing page:** quickstart shows `https://hello-<org>.telnyxcompute.com`; routing says `{func-name}-{func-id-prefix}.telnyxcompute.com` (first 10 chars of func_id, e.g. `hello-0198c2c5-8`). Routing is authoritative.
10. **Stale best-practices page** claims "There is no logs command and no metrics dashboard today… There is no surface that shows you `console.log` output" — contradicted by the CLI reference (`logs`, `metrics`) and the observability pages. Confusing for newcomers; the CLI is the real story.
11. **`/docs/edge-compute/reference/logs-metrics` (the URL in our brief) 404s** — the actual pages live under `/observability` (`/observability`, `/observability/logs`, `/observability/metrics`).
12. **CLI install has no package-manager path** (no npm/brew), and **un-versioned `releases/latest/download/...` URLs 404** — CI must resolve the version-stamped asset (the docs' own snippet does the redirect dance). `update` only exists from v0.5.13+.
13. **CLI ignores `TELNYX_API_KEY` env var** — headless/CI auth requires `auth api-key set` as a pipeline step.
14. **`new-func` registers server-side and is 429-limited** under rapid successive calls (one-time setup per function).
15. **Log levels unreliable** (best-effort, wrong on stack traces; multi-line errors split into separate lines); CLI `logs` reads are delayed a few seconds; `--tail` has no history; actor tails sever every ~10 min and **lose lines emitted during the reconnect gap**.
16. **CLI docs vs. releases drift:** reference page documents v0.5.14 while v0.5.17 is current; several features are version-gated and easy to miss (KV types ≥ 0.2.3; cloudstorage types ≥ 0.2.4; ratelimits ≥ 0.4.0 + SDK ≥ 0.9.2; log-export ≥ 0.5.3; `dev` ≥ 0.5.6/0.5.12 — the docs themselves disagree between the CLI reference "v0.5.6 or newer" and the local-development guide "v0.5.12 and later", which also changed dev's actor-runtime isolation behavior).
17. **KV namespace provisioning lag:** a fresh namespace is `pending` for a few seconds (~20 s worst observed); writes return 409 until `provision_ok`. Poll before first write in scripts.
18. **KV is not a coordination store:** no transactions/CAS; last-write-wins; cross-location reads are near-real-time. The docs repeat this loudly — actors are the fix, but actors are TS-only.
19. **Silent SDK behavior changes:** `expirationTtl` accepted but ignored before SDK 0.2.2; `list()` shape changed across 0.2.0–0.2.2 (throws on 0.2.0, name-only on 0.2.1). Pin versions.
20. **`metadata` on KV `put` compiles but is ignored** (deprecated) — a footgun for CF-Workers-habituated code.
21. **Env-var/binding name collision only warns** — both land on `env`, one shadows the other; `ship` proceeds.
22. **sqldb binding-id validation failures surface as a generic HTTP 500 that does not name the binding** (kv/sqldb/cloudstorage configs live outside the manifest; misconfigs are only caught at ship).
23. **No staging/promotion flag** — environments are separate functions with separate `func.toml`s; secrets are org-scoped and injected into *every* function in the org (no per-function secret visibility), and changes only land on next `ship`.
24. **Region placement is not controllable** ("You can't pin a function to a region today"), while `locationHint` on actors is accepted but ignored ("today it does" — reserved).
25. **Caller identity is not propagated** — no usable client IP (`x-forwarded-for` is platform-internal). Rate-limit/auth designs must use headers you control.
26. **Bodies pass through raw** (no base64/envelope) — good — but the TS scaffold buffers bodies as a string; binary bodies need buffer handling (`toString()` corrupts non-UTF-8).

---

## Open questions

1. **Does `ship` compile TypeScript for classic `func.toml` projects server-side (tsc/bundler), or does Node run TS natively?** The docs specify esbuild client-bundling only for umbrella `telnyx.toml` projects. Affects how much of the TS toolchain (path aliases, decorators, `.d.ts` generation) carries over. Needs an empirical test with a real scaffold.
2. **What is the Node version in the function runtime?** Prereqs say Node ≥ 18 locally; the deployed runtime version is not documented.
3. **Actor pricing** — are actor invocations/storage metered only via the function meters, or is there a hidden charge (e.g., `ctx.storage.sql` size)? Nothing published.
4. **Request streaming confirmation:** is chunked/streamed response transmission actually preserved end-to-end (no proxy buffering), and does a streamed response reset the 30 s timeout clock (e.g., for SSE keepalives)? Docs never discuss streaming explicitly; needs a live test.
5. **Cold-start magnitude** for a TS container (first request latency) — not documented; matters for the assistant's webhook latency budget.
6. **KV consistency for actor + function mixed access** — actors own their state; KV is read-your-writes per location. Fine in practice, but the interaction pattern (function writes KV, actor reads) is not documented.
7. **`telnyx-edge dev`** claims KV/SQL/alarms work locally but platform bindings don't — the boundary for KV-over-`env` locally (mocked? absent?) is only implied. Needs a test before relying on local iteration.
8. **MCP + 30 s budget:** Telnyx's own MCP server (`https://api.telnyx.com/v2/mcp`, streamable-http) is referenced in llms.txt — worth checking how Telnyx itself handles long tool calls on its hosted MCP endpoint, as a model for our own MCP server timeouts.

## Doc URL index used

- Overview: https://developers.telnyx.com/docs/edge-compute/overview
- Quickstart: https://developers.telnyx.com/docs/edge-compute/quickstart
- Execution model: https://developers.telnyx.com/docs/edge-compute/runtime/execution-model
- HTTP handler: https://developers.telnyx.com/docs/edge-compute/runtime/http-handler
- Bindings: https://developers.telnyx.com/docs/edge-compute/runtime/bindings
- Configuration (manifest): https://developers.telnyx.com/docs/edge-compute/configuration
- Routing: https://developers.telnyx.com/docs/edge-compute/configuration/routing
- Limits: https://developers.telnyx.com/docs/edge-compute/platform/limits
- Pricing: https://developers.telnyx.com/docs/edge-compute/platform/pricing
- KV: https://developers.telnyx.com/docs/edge-compute/kv · quick-start · concepts/how-kv-works · pricing
- Stateful Actors: https://developers.telnyx.com/docs/edge-compute/stateful-actors · quick-start · concepts/how-it-works · api-reference (namespace/stub) · websockets
- Observability: https://developers.telnyx.com/docs/edge-compute/observability · /observability/logs · /observability/metrics · /observability/api-reference · /observability/log-export
- CLI reference: https://developers.telnyx.com/docs/edge-compute/reference/cli
- Telnyx API binding: https://developers.telnyx.com/docs/edge-compute/telnyx-api
- Releases (verified via GitHub API): https://github.com/team-telnyx/edge-compute/releases
- 404: https://developers.telnyx.com/docs/edge-compute/reference/logs-metrics
