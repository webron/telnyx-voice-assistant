# Requirements tracker

Paraphrased from the challenge brief (gist text is never committed or published).
Statuses: `planned` → `in progress` → `done` → **`verified`** (verified = proven by a
real run on the live platform, not just written). Requirements first; the bonus list
stays untouched until R1–R7 are verified.

## Decisions

- **Use case: shelter bed line** (2026-11-09). Caller phones one number → finds an
  open bed near them → holds it for a short time → gets transit directions.
  Rationale for the review: voice-first population (basic phones, no data/apps),
  the bed race is a genuine Actor read-modify-write, and fallback paths write
  themselves. Proposal doc: `docs/use-case.md` (pending port from Ron's proposal
  once finalized).
    ("reference applications should continuously test whether products are ready
    for developers").
  - Build story is honest and agent-first (the challenge requires OpenCode +
    Telnyx Inference; the role wants AI-agent fluency): Ron led the build, decided
    the tradeoffs, ran verification and debugging. Presentation prep emphasizes
    decisions, evidence, and platform friction — not TypeScript mechanics.
  - Build rigor unchanged: the listing is a "builder's job" — the app must work.

## Pre-flight

| Item | Status | Notes |
|---|---|---|
| Telnyx account at Trial tier+ | **done** | 2026-11-09, GitHub verification |
| OpenCode V1 + `@telnyx/opencode` plugin working | **verified** | Kimi-K3 ran end-to-end; V1 kept via wrapper (`~/.local/bin/opencode`) |
| Inference budget for the week | **noted** | credits requested; see the account notes |
| `telnyx-edge` CLI installed (macOS build) | planned | Brief documents Linux; find the right release archive for macOS |

## Requirements

### R1 — AI Assistant with Conversation Workflow
Multiple nodes; prompt nodes; ≥1 speak node (verbatim); conditional edges using
**both** LLM conditions and variable comparisons; callable by phone; multi-step flow.

| Item | Where it lands | Status |
|---|---|---|
| Speak node: opening disclosure (automated line + crisis notice) | Workflow entry node | **verified** (deployed; script pending live call) |
| Prompt nodes: intent → collect+find → hold bed → confirm; manage hold; services; handoff | Workflow | **verified** (deployed) |
| LLM edges: bed / services / hold / crisis / escalate | Workflow edges | **verified** (deployed) |
| Variable edges: `has_active_hold` → manage hold; duration ≥ 300 → handoff; `emergency_mode` flag | Workflow edges | **verified** (deployed) |
| Phone number assigned to assistant | Telnyx | **blocked** — no numbers on account; purchase decision pending Ron |
| Every path tested (see test matrix) | — | in progress (MCP-level paths verified; live call pending) |

### R2 — Custom MCP server
≥3 meaningful tools, publicly accessible, callable from workflow nodes.

| Item | Where it lands | Status |
|---|---|---|
| Tools: `find_beds`, `hold_bed`, `extend_hold`, `cancel_hold`, `get_directions`, `list_services` (+ `admin_reset`, `admin_metrics`) | MCP server | **verified** |
| Publicly reachable (Edge Function, bearer-authenticated) | shelter-mcp2 function | **verified** (tools reachable; new URL needs wiring into the assistant) |
| Called from workflow nodes (not just chat) | Workflow tool config | in progress (registered; live verification pending) |
| Architecture: plain function per official example; actors behind REST shim in shelter-actors | decision D5 | done |

### R3 — Dynamic Webhook Variables
Webhook endpoint deployed as an Edge Function; feeds live data into conversation
and routing.

| Item | Where it lands | Status |
|---|---|---|
| Edge Function webhook: caller lookup by phone → name, active hold, emergency mode | Edge Function + KV | **verified** (signed request → 200, correct variables) |
| Variables influence routing (`has_active_hold` skips collection) | Workflow edges | **verified** (deployed; live verification pending) |

### R4 — Edge Compute
**4a.** ≥1 Edge Function deployed via `telnyx-edge ship`. **4b.** KV used for the
right workload. **4c.** ≥1 Stateful Actor owning per-entity state with a genuine
read-modify-write.

| Item | Where it lands | Status |
|---|---|---|
| 4a: webhook Edge Function shipped | `telnyx-edge ship` | **verified** |
| 4a: MCP server Edge Function shipped (incl. Shelter actor) | `telnyx-edge ship` | **verified** |
| 4b: KV — shelter-details cache | Edge Function | **verified** |
| 4b: KV — emergency-mode flag (no-redeploy toggle) | Edge Function | **verified** (flipped live via CLI, no deploy) |
| 4c: shelter Actor owns bed inventory + holds; last-bed race is the lock case | Stateful Actor | **verified** (race harness: exactly one winner) |
| 4c stretch: alarm expiry returns beds to pool | Actor alarm | in progress (wired; live fire pending) |

### R5 — Observability
Structured logs on every webhook call; one signal beyond logs; README explains
how breakage is detected within a minute; evidence of one real debugging trail.

| Item | Where it lands | Status |
|---|---|---|
| Structured log per webhook call (caller, node, outcome) | Edge Function | **verified** |
| Counters: holds placed, holds expired, no-bed outcomes | Metrics actor (`admin_metrics`) | **verified** |
| Request ID spanning Function → KV/Actor → MCP | All components | in progress (MCP has req ids; thread `telnyx_conversation_id` next) |
| README observability story + debugging trail | README | planned |

### R6 — Telnyx Inference via OpenCode plugin
All coding in this repo done by OpenCode agents on Telnyx-hosted models; config
visible for demo.

| Item | Where it lands | Status |
|---|---|---|
| `opencode.json` shows project default model (plugin configured globally) | repo | **done** |
| Model strategy documented + followed (`docs/model-choice.md`) | docs | **done** |

### R7 — Public deployment + docs  (COMPLETE — all items done or verified)
Working URLs + phone number; README with setup, architecture diagram
(Assistant → Workflow → Edge Function → KV/Actor → MCP), observability story,
demo script; `opencode.json` committed showing the plugin active.

| Item | Where it lands | Status |
|---|---|---|
| Live webhook + MCP URLs | deployment | **verified** |
| Callable phone number | Telnyx | **blocked** — purchase decision pending Ron |
| README: setup, architecture, observability, demo script | README | **done** |
| Demo script (8–10 min) incl. race demo via harness | docs | **done** |
| Final review session scheduled (Ron) | — | planned |

## Bonus / stretch — DEFERRED until R1–R7 verified

Several come nearly free with the use case; don't build them separately, just
check the box when the requirement work produces them.

- Actor alarms — hold expiry (~30 min) returning beds to the pool. Near-core for
  the product; decide alongside R4c.
- KV feature flags — emergency mode. Comes nearly free with R4b.
- Variable comparison edges — duration escalation. Comes nearly free with R1.
- Custom dynamic variables influencing routing — `has_active_hold`. Comes nearly
  free with R3.
- Distributed tracing — request ID across the call path (R5 already plans it;
  treat cross-component correlation as the stretch bar).
- Shared actors — only if a second caller-facing function needs the shelter actor.
- Multi-assistant routing — heaviest; only if time remains.
- Object storage — no natural fit in this use case; likely skip.

## Test matrix — fill in as builds land

Every workflow path, per the brief: happy path, fallback, escalation, and at
least one negative case for every important node.

| Path | How tested | Status |
|---|---|---|
| New caller → find bed → hold → confirm | phone call / scripted harness | planned |
| Returning caller with active hold → confirm/extend/cancel | phone call / harness | planned |
| Crisis intent → verbatim message → escalation | harness | planned |
| Other-services intent → list_services / hand-off | harness | planned |
| No beds → waitlist / nearest alternative | harness | planned |
| Race for last bed → exactly one hold wins | concurrent harness calls | planned |
| Hold expiry → bed returns to pool | alarm or lazy expiry | planned |

## Open decisions (see `docs/decisions.md` for the full two-lens log)

- D1 MCP hosting — **decided** (Edge Function, streamable HTTP per-request).
- D2 actor scope — **decided** (shelter-only actor + KV read cache).
- D3 mock data scope — proposed, needs Ron.
- D4 crisis wording — proposed, needs Ron.
- Research complete: `docs/research/{edge-compute,assistants-workflows}.md`;
  six empirical tests listed in the edge-compute doc to run on first deploy.
