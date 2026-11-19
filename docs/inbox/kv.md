# Telnyx KV — research notes

*Researched 2026-11-09. Sources: https://developers.telnyx.com/docs/edge-compute/kv, /quick-start, /concepts/how-kv-works, /reference, /reference/kv-namespace, /pricing, /ttl-and-metadata, /best-practices, /cli, /examples/session-storage, plus /docs/development/api-fundamentals/reliability/rate-limiting.md and the AI Assistants full docs (llms mirror). No 404s encountered; no contradictions found between pages except one REST URL-encoding inconsistency noted below.*

## 1. What is KV; namespace creation; TS binding; REST; assistant/workflow access

**What it is.** Globally distributed key-value storage for low-latency reads from edge functions; built for read-heavy edge workloads (session data, cached responses, feature flags). Values are **opaque bytes** — no envelope, no base64, no server-side interpretation. https://developers.telnyx.com/docs/edge-compute/kv

**Consistency model.** Single **global store**; no region selection at creation, no per-region copies. Writes are replicated and committed by quorum before acknowledgment. **Read-your-writes holds from a given location**; a read issued immediately after a write elsewhere may briefly see the previous value (cross-location visibility = near-real-time, not instant). "Distance costs latency, not staleness." Explicitly **no transactions and no compare-and-swap** — concurrent writers to one key are last-write-wins; not for counters, locks, or coordination. https://developers.telnyx.com/docs/edge-compute/kv/concepts/how-kv-works

**Namespace scope.** A namespace is an isolated key space. Create via CLI (`telnyx-edge storage kv create --name my-cache`, lowercase letters/numbers/hyphens) or REST `POST https://api.telnyx.com/v2/storage/kvs` with body `{"name": "my-cache"}`, `Authorization: Bearer $TELNYX_API_KEY`. Response includes namespace `id` (UUID) used everywhere after. **New namespace starts `status: "pending"` and writes return `409` ("Namespace is not ready") until `provision_ok` — a few seconds, up to ~20.** https://developers.telnyx.com/docs/edge-compute/kv/quick-start

**TypeScript edge function (`env` binding).** Declare in `func.toml`:

```toml
[edge_compute]
func_name = "my-function"

[storage.kv.MY_KV]
id = "550e8400-…"   # namespace id from creation
```

The block name is user-chosen and becomes `env.MY_KV` (typed `KvNamespace`). Requires `@telnyx/edge-runtime` ≥ 0.2.2; run `telnyx-edge types` (CLI ≥ 0.2.3) to generate `telnyx-env.d.ts`. Binding surface (https://developers.telnyx.com/docs/edge-compute/kv/reference/kv-namespace):

- `get(key)` → `Promise<string | null>` (null if missing)
- `get<T>(key, { type: "json" })` → `Promise<T | null>` (JSON.parse; empty value yields null; malformed throws)
- `put(key, value, { expirationTtl? })` → `Promise<void>`; value stored verbatim
- `delete(key)` → `Promise<void>`; **idempotent**
- `list({ prefix?, limit?, cursor? })` → `{ keys: { name, sizeBytes?, updatedAt? }[], list_complete, cursor? }` — **names + metadata only, never values**; needs ≥ 0.2.1 (0.2.0 throws "Unexpected KV list response shape")

**REST.** Same store, opposite half of the docs' two-paths table. Endpoints under `https://api.telnyx.com/v2/storage/kvs/{id}/keys/{key}` — `PUT` (body is the raw value; `?ttl_secs=N` for TTL), `GET` (response body is the raw value; **404 if missing**, SDKs map to null), `DELETE` (idempotent), `GET …/keys?prefix=&limit=&cursor=` (list; page-based `meta.has_more`/`meta.cursor`, no auto-pagination in SDKs). Auth: bearer API key. Value is raw request/response body — no base64, no envelope. SDK support: node ≥ 7.5.0, python ≥ 4.166.0, php ≥ 7.88.0, ruby ≥ 5.152.0, go ≥ v4.85.0; **Java SDK has no KV yet**. Inside an edge function the org binding injects the API key so REST calls need no shipped secret. https://developers.telnyx.com/docs/edge-compute/kv/quick-start

**Can a workflow/assistant read KV directly?** **Not per the docs.** The AI Assistants documentation (full-text mirror at https://developers.telnyx.com/public/llms/ai/assistants-full.txt) contains no mention of KV at all; the KV docs describe exactly two access paths — the TS function binding and the REST API. An assistant/workflow reaches KV only indirectly: a webhook or MCP tool it calls (e.g., an Edge Function) does the KV read/write. Treat "no direct access" as an absence-of-documentation finding, not an explicit "cannot".

## 2. TTL, limits, pricing

**TTL.** Server-side expiration on write via `expirationTtl` (binding; ≥ 0.2.2 — earlier versions **silently ignore** it), `ttl_secs` query param (REST), `--ttl 30s` (CLI; duration format `30s`/`5m`/`1h`). Whole seconds, range 1–9223372036; key is deleted server-side once it elapses; expired reads return `null`/404. Invalid TTL (non-integer, 0, negative) → `422`, key not written. **Binding quirk:** it floors fractional TTLs, and if the result is < 1 it sends **no TTL at all** — the write succeeds and the key never expires. TTL is renewed on every write (sliding expiry, per the session-storage example). There is **no way to read the remaining TTL back** — `get`/`list` never report expiry. The docs offer an application-level envelope (`{ value, expires_at }` wrapped JSON, check-and-lazy-delete on read) when you need inspectable expiry. https://developers.telnyx.com/docs/edge-compute/kv/ttl-and-metadata, https://developers.telnyx.com/docs/edge-compute/kv/examples/session-storage

**Limits.** Max value **1 MiB** (1,048,576 bytes) — larger write → `413`; store blobs in Cloud Storage and keep a reference. Max key length **256 chars** → `400`. Key charset `a-z A-Z 0-9 - _ / = .` — **no colons**. `list` page size 1–1000 (default 1000). **No published QPS/rate limit for KV**: the rate-limiting fundamentals page (https://developers.telnyx.com/docs/development/api-fundamentals/reliability/rate-limiting.md) says limits are per-endpoint and published in product guides, but the KV section publishes none. https://developers.telnyx.com/docs/edge-compute/kv/best-practices

**Pricing.** Free tier per month: 10M reads, 1M writes, 1M deletes, 1M lists, 1 GB storage. Paid: reads $0.35/M; writes, deletes, lists $3.50/M each; storage $0.35/GB-month. Egress free. https://developers.telnyx.com/docs/edge-compute/kv/pricing

## 3. DevEx friction (for the platform review)

1. **Provisioning race on a fresh namespace** — writes 409 until `provision_ok`; must poll unless using the binding path. Undocumented recovery semantics if it never reaches provision_ok.
2. **Silent-TTL failure mode** — `expirationTtl` < 1 after flooring writes *without* a TTL, no error (REST/CLI do 422). A bug class with real consequences (stale data forever).
3. **Version-gated APIs everywhere** — `expirationTtl` needs ≥ 0.2.2, `list()` metadata needs ≥ 0.2.2, `list()` itself throws on 0.2.0; CLI typegen needs ≥ 0.2.3. Easy to be one minor behind and lose data or crash.
4. **SDK footguns, documented but real** — PHP: unpinned `composer require telnyx/telnyx-php` installs v8.0.0 which predates KV (no `storage->kvs`); pinned v7.88.0's `update()` throws TypeError on every body type so you must use `$client->request()`; Guzzle required. Ruby needs `gem install base64` on ≥ 3.4. Go: the params `Body` field multipart-encodes the value; must use `option.WithRequestBody`. Java: no KV at all.
5. **REST slash-encoding ambiguity** — quick-start curl writes `…/keys/user/123` (slash literal) while the TTL page writes `…/keys/session%2Fabc` (slash encoded). Both hit the same endpoint shape; the docs never state which is canonical or whether the API treats the whole remainder as the key.
6. **No remaining-TTL readback, no metadata, no CAS** — inspectable expiry only via the DIY envelope; anything state-machine-like needs an edge function (Stateful Actor) instead.
7. **`metadata` option lingers as deprecated-and-ignored** — accepted on `put` and on `KvKeyInfo` but never populated; older code compiles and quietly loses data.
8. **Rate limits undocumented for KV** — unlike other Telnyx products, no QPS budget published; scaling claims ("read-heavy edge workloads") are unquantified.
9. **No KV ↔ assistant bridge documented** — the natural "assistant reads its namespace" story doesn't exist on paper; you must build the webhook/MCP hop yourself.
10. **Positives, worth saying:** the docs are unusually candid (version gates called out inline, PHP/ruby/go gotchas spelled out, idempotency stated per-operation, list-pagination semantics explicit, free-tier split visible on one table). Friction is mostly version churn and SDK maturity, not documentation quality.

## Gotchas

- Namespaces start `pending`; first write 409 until provisioned (~20s worst case).
- `expirationTtl` silently ignored on `@telnyx/edge-runtime` < 0.2.2, and values < 1 (post-floor) are dropped silently at any version.
- `delete` idempotent; REST missing-read is 404 not 200-null; SDK exceptions vary by language (NotFoundError).
- Keys are case-sensitive, no `:`, max 256 chars; values max 1 MiB.
- Cross-location stale reads possible for a brief window; same-location read-your-writes is solid.
- Concurrent writers → last-write-wins; no atomic read-modify-write (KV alone cannot implement the Stateful-Actor pattern).
- PHP composer pin trap (v8.0.0 predates KV); Java SDK has no KV.
- CLI `create` name restricted to lowercase letters/numbers/hyphens; REST body `name` presumably the same (not restated on the API tab — minor doc gap).

## Open questions

- Is there a published QPS/rate limit for KV endpoints anywhere (Portal settings, API error codes page)? None found in the docs I searched.
- Does the REST/CLI namespace-creation `name` enforce the same charset as the CLI (lowercase, numbers, hyphens)? The CLI tab says so; the API tab doesn't restate it.
- Is KV readable from the Mission/AI-Inference products the way assistants might reach webhook data? Nothing in the assistants docs suggests so; unverified either way.
- Behavior when a namespace's owner org is deleted / keys hit storage quota — no doc found.
