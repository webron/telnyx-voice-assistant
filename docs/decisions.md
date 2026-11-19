# Decision log

Every meaningful decision, recorded with both lenses:

- **Builder lens** — what the decision feels like as a developer building on
  Telnyx (DevEx: friction, clarity, trust).
- **PM lens** — what the same decision says about Telnyx's products (what we'd
  improve, ship, or measure as part of Telnyx's own product work).

Product-relevant decisions are surfaced to Ron with a recommendation before
deciding; purely engineering decisions are made directly and logged here.

Format: date · decision · status (proposed / decided / superseded).

---

### D5 — MCP server as a plain function; actors behind a REST shim — **DECIDED 2026-11-11**
- **Decision:** shelter-mcp2 is a plain function (no actor bindings) running the
  verified SDK streamable-HTTP transport; Shelter/Counters actors live in a new
  owner function (shelter-actors) behind a thin REST shim; the MCP tools call the
  shim over HTTPS. Aligns with Telnyx's own `examples/ts/mcp-server` pattern
  (plain function, no actors, Knative health probes).
- **Why:** the deploy health check times out on every combination of actor binding
  and bundle (owned classes, reference bindings, light, heavy) once the MCP server
  and actors shared a function. The official example separates them by design.
  Eliminates the entire failure class.
- **PM lens:** the platform's own examples contain the answer that its docs pages
  lack — a discoverability finding, and the exact shared-actor limitation the
  reference docs understate ("warns and proceeds" is not what we hit).

## Pending (pre-registered; research feeds them)

### D1 — MCP server hosting & transport — **DECIDED 2026-11-09**
- **Decision:** MCP server runs as a Telnyx Edge Function, streamable-HTTP
  per-request mode (each tool call = one POST → one JSON response). Every tool
  completes in well under the 30 s request budget. No SSE, no WebSocket transport.
- **Why:** Edge Functions are containers with a 30 s/60 s request cap and no
  long-lived-connection support on plain functions; the MCP HTTP transport fits
  that exactly, and it keeps the whole stack on Telnyx (one deploy story, one
  URL domain). A separate host would add cost, a second platform, and a weaker
  demo story.
- **PM lens:** Edge Functions' request/response shape (no SSE, short timeouts)
  is real product feedback — worth one line in the friction log: "stateful or
  streaming server types would unlock more server-product shapes."

### D2 — Stateful Actor scope — **DECIDED 2026-11-09**
- **Decision:** one actor **per shelter** (`idFromName(shelterId)`), owning bed
  inventory and the caller→hold map; no per-caller actor. The webhook reads a
  KV cache of the caller's hold (single writer: the actor, which updates it on
  hold/cancel/expire), with the actor as source of truth on miss. DV webhook
  timeout raised to 8000 ms.
- **Why:** the race (last bed) is the one place RMW matters; per-caller state
  without contention doesn't need an actor. KV's write bill is fine at this rate
  (writes only on hold/cancel/expire). Actor cold start is hidden behind the
  8 s DV timeout with KV as the fast path.
- **Builder lens:** "Actor where the race is; KV for fast reads" is the
  primitive-choice story for the review.
- **Status:** decided; empirical race test on the live platform still required.

### D3 — Mock data scope — **DECIDED 2026-11-09 (Ron)**
- **Decision:** Fictional metro ("Riverbend", Chicago-shaped) — 5 shelters, 3–15
  beds each, one scripted seed command. Two shelters kept near-full so the
  no-bed path and the last-bed race are reproducible on demand.
- **Why (Ron's call):** a fictional city avoids implying affiliation with any
  real 211 network or shelter, and sidesteps the data-accuracy trap — the story
  stays honest: a demo of the pattern, with the structure of a real deployment.

### D4 — Crisis-path wording — **DECIDED 2026-11-09 (Ron)**
- **Decision:** verbatim speak node: "This line is for shelter referrals. If
  you are in danger or need medical help, call or text 988, or dial 911."
  Plus a clear "automated demo line with sample data" line, then route to a
  human-hand-off node.

---

## Log

*Decisions append here as they land.*
