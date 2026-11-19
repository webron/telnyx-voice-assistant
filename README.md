# Riverbend Shelter Bed Line

A voice AI that helps people find an open shelter bed **tonight**, holds one for
them for 30 minutes while they travel, and gives them transit directions — built
entirely on Telnyx: AI Assistants (Conversation Workflows), Edge Functions, KV, and
Stateful Actors.

## The problem

People experiencing homelessness often have a phone but no data plan — voice is the
channel they actually have. Today, 211 lines and shelter staff do this by hand: the
caller waits on hold, a person reads bed counts from a spreadsheet, and the bed is
"held" informally — often lost in the shuffle. The shelter bed line automates that:
one number, an intake conversation, a real hold (single-threaded, so two callers
can't hold the last bed), and transit directions.

## Architecture

```
Caller (verified number)
   │  voice
   ▼
Telnyx AI Assistant ── Conversation Workflow (8 nodes)
   │  greeting (speak, verbatim 9-8-8/9-1-1)
   │  intent (LLM edges: bed / services / hold / crisis / handoff)
   │  variable edges: has_active_hold · emergency_mode · duration
   │  collect_needs ──► intake question ──► find_beds
   │  manage_hold ────► hold_status / extend / cancel
   │  services ───────► list_services (with directions)
   │  crisis (speak, verbatim) ──► human_handoff
   │
   ├──► shelter-webhook (Edge Function) ── signed DV lookup at call start
   │        └─ reads/writes KV: hold cache, snapshots, emergency flag
   └──► shelter-mcp2 (Edge Function) ── MCP server · 8 tools
            └─ REST shim ──► shelter-actors (Edge Function, actor owner)
                                └─ Shelter actor (Stateful Actor)
                                     └─ KV: hold cache · snapshots · flags
```

Live Edge Functions:
- `shelter-webhook` — the Dynamic Variables webhook (signed, verified)
- `shelter-mcp2` — the MCP server (8 tools, streamable HTTP)
- `shelter-actors` — the actor owner (Shelter class + REST shim)

## Setup

```bash
# Install the CLI (macOS arm64 shown; see releases for other targets)
VERSION=$(curl -s https://api.github.com/repos/team-telnyx/edge-compute/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
curl -sSL "https://github.com/team-telnyx/edge-compute/releases/download/$VERSION/telnyx-edge-$VERSION-macos-arm64.tar.gz" | tar xz
sudo mv "telnyx-edge-$VERSION-macos-arm64/telnyx-edge" /usr/local/bin/

# Authenticate
telnyx-edge auth api-key set "$TELNYX_API_KEY"

# Seed the demo data (shelters, services, emergency flag)
KEY=$(sed -n 's/.*api_key = "\(.*\)".*/\1/p' ~/.telnyx-edge/config.toml) node scripts/seed.mjs

# Deploy (three Edge Functions)
cd edge/actors      && telnyx-edge ship   # owner: Shelter actor + REST shim
cd ../shelter-mcp2  && telnyx-edge ship   # MCP server (plain function)
cd ../webhook       && telnyx-edge ship   # DV webhook

# Wire the assistant (create/update via the API)
node assistant/deploy.mjs
```

### The call path

1. Caller dials **+1 (603) 515-5568** from their verified number
2. Telnyx routes to the TeXML app → the AI Assistant initializes → the DV webhook
   fires: `shelter-webhook` verifies the caller's signature, reads the hold cache
   and the emergency flag from KV, and returns `caller_id`, `has_active_hold`,
   `hold_expires_min`, `emergency_mode` as dynamic variables
3. The workflow's variable edges route deterministically: `has_active_hold` →
   `manage_hold` (status, extend, cancel); otherwise `intent` → intake → search
4. Tool calls flow: assistant → `shelter-mcp2` (MCP) → REST shim → the Shelter
   actor (single-threaded holds) → KV

### Requirements

- Telnyx account (AI Assistants, Edge Compute, KV, Stateful Actors)
- A verified phone number (trial tier limits inbound to the verified number)
- Node 20+ (for the deploy scripts and the test harness)

## The conversation flow

| Node | Type | Purpose |
|---|---|---|
| greeting | speak | Verbatim — the 9 8 8 / 9 1 1 wording, spoken as digits |
| intent | prompt (LLM edges) | Classify: bed / services / hold / crisis / handoff |
| collect_needs | prompt | One combined intake question, then find_beds → offer |
| manage_hold | prompt | Hold status, extend, cancel — hold_status first |
| services | prompt | list_services (with each service's own directions) |
| crisis | speak | Verbatim — the 9 8 8 / 9 1 1 message, never paraphrased |
| human_handoff | prompt | Apology + referral (the safety net) |

**Variable edges** (deterministic, no model): `has_active_hold` → `manage_hold`;
`emergency_mode` → the crisis-aware greeting; `telnyx_conversation_duration_secs`
→ the handoff.
**LLM edges**: bed / services / hold / crisis / handoff routing from `intent`;
crisis routing from every node (the safety path is reachable from anywhere).

## Observability

**Structured logs** on every request:
- `dv-webhook` lines from the webhook: the caller number, the hold state, the
  emergency flag, the latency
- `mcp-tool` lines from the MCP server: the tool name, the caller, the latency,
  `isError`
- The actor logs: the holds, the resets, the alarm firings

**Signals beyond logs**:
- Per-turn latency in the conversation transcripts (LLM first token, audio first
  token, end-user perceived latency — the platform records all three)
- The platform's own metrics: request counts, p50/p95, error rates per function
- The `hold_status` tool: the caller can ask "how much time is left?" and the
  model answers from the actor's live state (not a guess)

**How we'd know within a minute that the line is broken:**
1. The DV webhook stops returning 200 (check the invocation logs — a 500 or a
   timeout shows up within a minute of the next call)
2. The `mcp-tool` logs stop (the tool calls fail silently → check `isError`)
3. The conversation transcript shows the model improvising (no tool calls → the
   MCP server is unreachable → check the function is deployed)
4. The caller hears "I can't connect you directly" — the handoff node's apology —
   which means the tools are down, not the conversation

---

## The debugging stories

Three failures worth telling — all with logs as evidence:

1. **The trial-tier call gate.** Every call disconnected before the assistant
   initialized — no webhook, no conversation, no error. The unlock: an outbound
   test call returned D60/D61 ("the portal level doesn't allow this type of
   calls"). The trial tier requires a verified number for inbound calls. Fix:
   verify the caller's number. Lesson: when the failure has zero evidence, check
   the platform tier before the code.

2. **The 4-minute silence.** A call had a 4m15s gap between the caller's question
   and the reply. The unlock: the MCP invocation logs showed the client's GET
   (SSE channel) hanging 3–5 minutes, then 500 — the platform proxy killed held
   streams. The tool calls were fine; the stream wasn't. Fix: 405 on GET (the MCP
   spec allows it — the client doesn't need server-initiated SSE). Lesson: when
   the delay isn't in the tool calls, check the transport layer.

3. **The actor-image build gate.** The actors function failed 4/4 deploys with
   "the image for its actor type was still being built." The unlock: removing the
   Counters actor (metrics only — R5 was covered by the latency logs) unblocked
   the deploy instantly. Lesson: an actor type that exists only for metrics is a
   liability, not an asset.

---

## Known limitations

- The trial tier restricts inbound calls to the verified number — reviewers can't
  dial in from their own phones unless the account is upgraded
- The TTS reads the greeting verbatim; the 9 8 8 / 9 1 1 wording is tuned for
  pacing, but the exact read depends on the voice model
- The tool-call latency varies with actor cold starts (~1–3s); the `/warm` call
  during call setup mitigates it

## The friction log

Seven platform findings — with evidence — in `docs/friction-log.md`.

---

## File map

```
edge/
  webhook/          # DV webhook (shelter-webhook) — signed caller lookup
  shelter-mcp2/     # MCP server (shelter-mcp2) — 8 tools, streamable HTTP
  actors/           # Actor owner (shelter-actors) — Shelter class + REST shim
  mcp-server/       # (removed — see the build log)
assistant/
  assistant.json    # The assistant + workflow definition
  deploy.mjs        # Idempotent create/update via the API
scripts/
  seed.mjs          # Shelter index, services, emergency flag → KV
  race.mjs          # The last-bed race harness (two concurrent holds)
docs/
  demo-script.md    # The call sheet
  friction-log.md   # Platform findings, with evidence
  requirements.md   # The requirements tracker
```
