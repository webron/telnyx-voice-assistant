# Friction & lessons log

Everything that went wrong or cost time, kept deliberately: the platform findings,
the documentation gaps, and our own mistakes — process signal for the review.

## A. Platform issues

1. **Deploy pipeline wedges, then fails.** `telnyx-edge ship` uploaded fine, then sat
   in `deploying` for 15–20 minutes before reporting `deploy failed`. During the wedge
   the function is locked — every retry gets HTTP 409 (`ship already in progress`).
   Pattern seen 5+ times in 12 hours on one function (revision IDs and timestamps in
   the build log), while a sibling function created the same day deployed in 2–5
   minutes. Recovery from the CLI: none — the docs' remedy is "contact support."
2. **Deploy status reporting is unreliable.** At least one `deploy failed — function
   was not updated` turned out to be false: the new revision *was* live and serving
   (verified by behavior, not by status). The platform's own status cannot be trusted
   as the single source of truth; we now verify by hitting the URL.
3. **Actor deployments gate every ship, opaquely.** Each actor type gets its own
   deployment; a ship rolls out the function plus every declared actor type and fails
   whole-ship if any actor deployment misses a readiness window ("actor type X did
   not start in time"). Nothing in the docs describes this gate, its timeout, or what
   readiness means for an actor pod. We lost hours to a rule we could not have known.
4. **Reference actor bindings break deploys.** Docs say a reference binding to
   another function's actor type "warns and proceeds." Our ships with reference
   bindings (light or heavy bundles) failed 3/3 with actor-start timeouts.
5. **Assistant MCP integration requires streamable-HTTP (GET/SSE sessions), not just
   JSON-RPC-over-POST.** A stateless JSON-RPC MCP server (protocol-compliant by spec)
   kills assistant chat/calls with an opaque 500, because the client's GET opens an
   SSE channel and it treats 405 as fatal. Only discoverable via invocation-log
   forensics (a lone `GET 405` line). The assistants docs say "HTTP and SSE
   transports" without explaining what "HTTP" actually requires server-side.
6. **Edge Function→Assistant MCP over KV/actor state is one big happy family, but
   "does the MCP server live in the same function as actors?" has no documented
   answer.** The official `examples/ts/mcp-server` in the edge-compute repo — a plain
   function, Express + telnyx-mcp, no actors — is the intended pattern, and it is not
   linked from any developer doc we read.
7. **`ship` build failures vs deploy failures surface at different layers, and
   "temporary problem on our side, please try again" repeats identically for
   persistent, function-specific conditions** (3/3 after a full `reset-func`).

## B. Documentation gaps (what would have saved hours)

1. **Integration secrets are referenced by `identifier`, not by id.** The Portal guide
   says "the identifier is a reference to the stored credential"; the API reference
   does not, and `api_key_ref` with the UUID fails with "not found." Cost: two
   dead-ends.
2. **Scaffold layout is different per flavor** (`--actor` → `src/` + `telnyx.toml`;
   plain → root `index.ts` + `func.toml`), and builds compile from the manifest's
   expected entry — not from wherever files land. Undocumented; cost: one
   shipped-but-wrong revision plus confusion.
3. **Build environment is stricter than the local one**: NodeNext module resolution
   with explicit `.js` import extensions, and the generated `telnyx-env.d.ts` (from
   `telnyx-edge types`) must exist before the build — locally, my looser tsconfig
   hid both. `telnyx-edge types` is documented as a step but its necessity at build
   time is easy to miss (and a scaffold that ran typegen automatically, or a build
   that tolerated bindings, would remove the whole failure class).
4. **Scaffold dependencies start minimal** (`@telnyx/edge-runtime` only); any other
   dependency (MCP SDK, zod) must be added before the first ship. Fine to learn, but
   the first build failure is where I learned it.
5. **The examples/ repo is the real documentation** for anything non-trivial
   (streamable MCP). The docs pages never mention it.

## C. Our own mistakes (process notes for next time)

1. **Scaffold/file-layout thrash** — three separate errors from one cause: assuming
   where files live. Remedy: verify the directory contents after scaffolding, before
   writing code (and after each `new-func`, since layouts differ).
2. **Shell one-liner quoting failures during diagnosis (3×)** — burned time and
   produced false alarms mid-debug. Remedy: if a probe needs complex quoting, write
   it to `scripts/` first, run it from there.
3. **Guessed instead of reading the exact error**: the `10027` "secret not found"
   error said precisely what was wrong; I tried the UUID first, found the identifier
   fix only later. Remedy: error text first, hypothesis second.
4. **Trusted deployment status over live behavior**: I read `deploy failed` as "not
   live" and lost the thread once (02:39 GET 500s came from a live-but-broken
   revision, not a missing one). Remedy: after any deploy event, `curl` the URL
   before concluding anything.
5. **Retry discipline**: two identical 20-minute wedge failures in a row before the
   stop-rule landed. The stop-rule itself came from Ron; the process fix is to apply
   it *after the first repeat*, not the second.
6. **Local-pass ≠ platform-pass**: the SDK server ran perfectly on local Node 22 and
   failed the platform's readiness on Node 24 (or the container's proxy). Remedy:
   match the runtime (`nvm`/docker) before shipping when a failure is
   environment-shaped.


## F. The verified-number gate (2026-11-11) — the biggest time-waster of the build

**What happened:** Every inbound call disconnected before the assistant ever
initialized — no webhook call, no conversation, no log line of any kind. Five
calls across two days. We debugged the assistant (MCP transport, tool envelopes,
secret references, deploy gates) while the real cause sat one level up.

**The cause:** On the Trial tier, voice is gated by a *verified number*: outbound
is limited to dialing the verified number and — critically — *inbound* is limited
to receiving from the verified phone number. We had zero verified numbers, so every
call was rejected at the network layer, before the assistant platform ever saw it.
The fix took 60 seconds: register the caller's number via
`POST /v2/verified_numbers` (SMS code) → `POST /verified_numbers/{id}/actions/verify`.

**Why it took so long (the honest anatomy):**
1. The failure was **completely silent** on our side — the platform accepts the call
   and drops it with no API-visible trace, error, or event. Zero evidence is the
   evidence, but only if you know to look upstream.
2. The error surfaces **only on the outbound path** — `POST /v2/texml/ai_calls`
   returns D60/D61 ("user portal level doesn't allow this type of calls... upgrade
   their account to a higher level") with full text. The inbound path shows nothing.
3. The docs **had the answer** (Trial tier → Voice → "Inbound limited to receiving
   from the verified phone number") — a scanning read for AI-assistant limits never
   surfaced the voice section, because nothing in the symptom pointed at account
   tiers.
4. Every chat-level fix in the meantime was a *real* bug (proven by chat failures
   independent of voice) — which reinforced the wrong causal chain. Chat never
   exercised the phone path, so the disconnect survived every fix.

**Lessons (process, for next time):**
- "Zero server-side evidence" means "check upstream gating first" — account tier,
  number provisioning, feature gating — before debugging downstream code.
- Make the platform perform the action and read *its* error (outbound-call probe)
  when the inbound path is silent.
- A doc-read pass should cover the product's *own tier/limit pages* end to end,
  not just the API surface of the feature being built.

**Demo-day implication:** Trial tier only permits calls from the verified number —
reviewers can't dial in from their own phones unless the account is upgraded to
Paid. Either the demo script notes it, or the account upgrades.

## G. Actor alarm set but never delivered (2026-11-12)

**What happened:** Placed a 1-minute hold, expecting the actor alarm (set via
`ctx.storage.setAlarm`) to fire at expiry and free the bed. The alarm never
delivered — no invocation, no error, no retry (at-least-once delivery should have
redelivered 3×). The bed stayed "held" in KV for 20+ minutes.

**Evidence:** Actors invocation logs show zero `alarm()` deliveries after the
set; a `find_beds` 75 seconds after expiry still showed the stale count. A
`hold_status` call (which runs `pruneExpired()` on read) then pruned the expired
hold and the snapshot refreshed immediately.

**Current state:** The lazy prune on read (every `state()`/`holdFor()` call, plus
the DV webhook's `/warm` fire-and-forget at call start) keeps counts fresh — the
demo works regardless. But the documented alarm mechanism failed silently, which
for a platform is the worst kind of failure: a scheduled task that doesn't run and
doesn't tell you.

actor instances in the new owner function (post-ownership-transfer) never fired —
the alarm window fell outside any deploy window, so this wasn't a lost-during-deploy
artifact. Consider surfacing alarm delivery failures, or an inspect command for
pending alarms.
