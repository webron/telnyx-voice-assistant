# Reference: AI Assistants, Conversation Workflows, Dynamic Webhook Variables

Distilled 2026-11-09 from `docs/inbox/assistants-workflows.md` (all sources live-fetched from
developers.telnyx.com, all 200). Facts only; conflicts shown as conflicts. One URL per section.

## 1. Assistant creation & phone binding

Doc: API reference — https://developers.telnyx.com/api-reference/assistants/create-an-assistant

- Create: `POST https://api.telnyx.com/v2/ai/assistants` (Bearer key; optional `Idempotency-Key` header).
  Required: `name`, `instructions`. Everything else optional, defaults apply.
- Key `CreateAssistantRequest` fields:
  - `model` — used unless `external_llm` set. If neither `model` nor `external_llm` given, default
    model applies; the Voice Assistant quickstart names it as `zai-org/GLM-5.3-Flash`.
  - `instructions` — system prompt; supports `{{dynamic_variable}}` templating.
  - `greeting` — templated text. Empty string = wait for user to speak first; special value
    `<assistant-speaks-first-with-model-generated-message>` = model-generated greeting.
  - `voice_settings` — TTS: `voice` (formats: `Telnyx.KokoroTTS.af_heart`, ElevenLabs via
    `api_key_ref`, Soniox `Soniox.tts-rt-v2.<voice_id>`, MiniMax `language_boost`), `voice_speed`
    (0.6–1.5 for Telnyx Ultra), `api_key_ref` (integration secret), ElevenLabs-only knobs
    (`temperature`, `similarity_boost`, `use_speaker_boost`, `style`, `speed`), `expressive_mode`,
    background audio. TTS providers: Telnyx, AWS, Azure, ElevenLabs, Inworld.
  - `transcription` — STT: `model` (e.g. `deepgram/flux`), language, region, endpointing.
  - `telephony_settings` — `default_texml_app_id` ("Default Texml App used for voice calls with your
    assistant. This will be created automatically on assistant creation"), `time_limit_secs`
    (default 1800), `user_idle_timeout_secs`, noise suppression (`aicoustics`/`krisp`/
    `deepfilternet`/`disabled`), recording, voicemail detection, `supports_unauthenticated_web_calls`.
  - `messaging_settings` — `default_messaging_profile_id`, `conversation_inactivity_minutes`,
    `delivery_status_webhook_url`.
  - `mcp_servers` — `[{id, allowed_tools?}]` referencing `/ai/mcp_servers` entries.
  - `tool_ids` / `tools` — shared tools (preferred) vs deprecated inline tools.
  - `dynamic_variables` — name → default value map.
  - `dynamic_variables_webhook_url` + `dynamic_variables_webhook_timeout_ms` — §4.
  - `conversation_flow` — the workflow graph (§2).
  - `enabled_features` (e.g. `TELEPHONY`), `insight_settings`, `privacy_settings`,
    `observability_settings`, `widget_settings`.
- Phone binding:
  - Inbound: Portal assistant-creation flow has an "(Optional) Assign a phone number" step
    (attach a purchased number with voice features; skippable, assignable later). Under the hood
    each assistant gets a TeXML app auto-created (`telephony_settings.default_texml_app_id`).
    There is a `GET /ai/assistants/{assistant_id}/texml` reference in the API index.
  - Outbound via API: `POST https://api.telnyx.com/v2/texml/ai_calls/<texml_app_id>` with `From`,
    `To`, `AIAssistantId`, optional AMD params.
  - Programmatic inbound: Call Control "Start AI Assistant" command on a call leg.
- Takeaway: one create call can carry the entire system (model, instructions, voice, TeXML app,
  MCP servers, tools, workflow graph, DV webhook URL). Portal = same config + canvas editor.

## 2. Conversation Workflows

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/workflows
(schemas from the create-an-assistant OpenAPI spec, §1 URL).

### Shape & storage

`conversation_flow = {start_node_id, nodes[], edges[]}` on the assistant. Node/edge IDs are
caller-supplied strings; validation enforces unique IDs and endpoints referencing real nodes.
`edges` may be empty (single-node flow). Updates are atomic: omit `conversation_flow` to leave
unchanged; send `conversation_flow: null` to clear. Any single-node/edge change = resend whole
graph. `position {x,y}` exists only for authoring UIs and round-trips.

### Node types (3)

1. **Prompt** (`type:"prompt"`, default) — LLM turn. Fields: `id`, `instructions` (required),
   `name`, `instructions_mode` (`replace` default | `append` — appends node instructions after
   assistant instructions), `model` / `llm_api_key_ref` / `external_llm` (LLM override bundle: set
   ANY one and all three must come from the node), `shared_tool_ids` + `tools_mode`
   (`replace` default | `append`) for per-node tool scoping, `voice_settings` (unset fields
   cascade), `transcription` override, `position`.
2. **Speak** (`type:"speak"`) — deterministic, no LLM turn. Fields: `id`, `message` (required,
   verbatim, supports `{{variable}}` interpolation; unresolved placeholder renders as empty
   string), `name`, `position`. No SSML in the schema. (Portal: Ultra/xAI Grok voices support
   inline SSML emotion tags and nonverbal cues like `[laughter]` — a TTS feature, not a node field.)
3. **Tool** (`type:"tool"`) — deterministic, no LLM turn. Fields: `id`, `shared_tool_id`
   (required — org-level shared tool), optional `message` spoken BEFORE the tool runs (so the tool
   result is NOT available in it), `name`, `position`. Arguments resolve by name from dynamic
   variables (a variable matching a tool parameter supplies that argument). Executed on entry.

Special tool-node rules: hangup tool node ends the call, accepts no outgoing edges; transfer tool
node accepts at most one outgoing default edge (used only if the transfer fails).

### Edges

`FlowEdge = {id, start_node_id, target, condition}`. Target: `{type:"node", node_id}` or
`{type:"assistant", assistant_id, voice_mode: unified|distinct, position}`. Assistant targets
rewrite the active assistant; the target's flow starts at its own `start_node_id`;
`voice_mode: distinct` gives it its own voice. Condition types:

- **`llm`** — `{type:"llm", prompt:"<natural language>"}`. On calls: each LLM edge from the active
  node is offered to the model as a tool named `transition__<edge_id>` with the prompt as
  description; fires only if the model calls that tool in the same turn as its reply. On chat
  channels: after the reply, a separate model call evaluates every outgoing LLM edge as
  statements; first true in declaration order wins.
- **`expression`** (variable comparison) — `{type:"expression", expression:<Expression AST>}`.
  Structured AST only; no string expression language. AST variants:
  - `comparison` — `op` ∈ `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `not_contains`
    (contains/not_contains: substring on strings, membership on arrays); operands are
    `variable` / `number_literal` / `string_literal` / `bool_literal`.
  - `bool_op` — `and`/`or` n-ary (≥2 operands), `not` unary.
  - `arithmetic` — `+`, `-`, `*`, `/`, `%`.
  - Example (workflows-page escalation pattern):
    `{"type":"expression","expression":{"type":"comparison","op":">=","left":{"type":"variable","name":"telnyx_conversation_duration_secs"},"right":{"type":"number_literal","value":300}}}`
- **`default`** — `{type:"default"}`; fires only if no other outgoing edge matched. Valid only on
  edges leaving speak/tool nodes. Speak node: exactly one outgoing default edge required. Tool node
  with any outgoing edges: exactly one default edge among them (zero edges = valid terminal).

### Evaluation order

- Expression (variable-comparison) edges evaluate in `edges` declaration order; first true wins.
- Default is always considered last, regardless of array position.
- On calls, expression conditions evaluate BEFORE the model turn and pre-empt LLM edges regardless
  of declaration order — a matching expression edge routes before the model sees any
  `transition__` tools. So expression > LLM on calls, always.
- On chat: an expression edge already true at turn start routes before the reply; after the reply,
  remaining conditioned edges are considered together in declaration order (an LLM edge declared
  earlier can beat an expression edge that became true mid-turn).
- Among LLM edges on calls, the model chooses (declaration order = tool-offer order); on chat,
  first true in declaration order.

### System variables

From the dynamic-variables page (+ quickstart where noted):

| Variable | Notes |
|---|---|
| `telnyx_current_time` | plus IANA variants `telnyx_current_time_America/New_York`, shorthands `telnyx_current_date`, `telnyx_current_time_of_day`, `telnyx_current_weekday`, `telnyx_current_month`, `telnyx_current_day`, `telnyx_current_year`; strftime filter: `{{ telnyx_current_time \| date: "%I:%M %p", "America/New_York" }}` |
| `telnyx_conversation_channel` | `phone_call` \| `web_call` \| `sms_chat` |
| `telnyx_agent_target`, `telnyx_end_user_target` | numbers |
| `telnyx_shaken_stir_attestation` | `a` \| `b` \| `c` |
| `call_control_id` | |
| `telnyx_sip_header_user_to_user`, `telnyx_sip_header_diversion` | quickstart page |
| `telnyx_last_tool_status_code` | set by tool nodes; **string on voice (`"200"`), number on chat (`200`)** — used in expression edges |
| `telnyx_conversation_duration_secs` | in workflows examples (`>= 300`); NOT in the DV system-variable table |
| `telnyx_end_user_target_verified` | STIR/SHAKEN full-A verification; in DV webhook payload; NOT in the table |
| `telnyx_conversation_id` | platform-set; delivered via DV webhook payload and MCP `_meta` |

## 3. Tools & MCP

Doc: MCP guide — https://developers.telnyx.com/docs/development/mcp/assistant-mcp-servers
(+ create-server API: https://developers.telnyx.com/api-reference/mcp-servers/create-mcp-server)

- Create account-level server: `POST /ai/mcp_servers` with `name`, `type`, `url`, optional
  `api_key_ref` (integration-secret id), optional `allowed_tools`. Attach on the assistant via
  `mcp_servers: [{id, allowed_tools?}]`; the per-assistant list overrides the server-level
  allowlist when present.
- Transports: Portal guide documents **HTTP** and **SSE** only; no `stdio` (hosted execution).
  The API spec's `type` is a plain string with **no documented enum** — allowed values are only
  in the portal docs (gotcha §6).
- Auth: API key as Integration Secret referenced by `api_key_ref`. If the URL itself is a
  credential it can also be an integration secret ("+ Append integration secret" under URL field).
  No custom per-request headers in server config; per-caller credentials come via
  `encrypted_dynamic_variables` from the DV webhook (per-caller-credentials doc).
- Per-server `Tool timeout (ms)` caps a single tool call.
- Per-node scoping — two models:
  - API: `shared_tool_ids` + `tools_mode` on prompt nodes (`replace` = only node's tools callable;
    `append` = added to assistant tools). Requires everything to be a shared tool.
  - Portal: node's Tools tab shows inherited tools with per-node toggles (enabled by default)
    plus "Added for this node" node-only tools.
- Context injection: Telnyx adds `telnyx_conversation_id` to every MCP tool call at
  `params._meta.telnyx_conversation_id`. Platform-set, not model-set → not prompt-injectable.
- Failure behavior:
  - Tool nodes: HTTP status lands in `telnyx_last_tool_status_code`; route success/failure with
    expression + default edges. Deterministic path.
  - Prompt-node tool calls (model-invoked): no documented automatic fallback/retry. Docs say
    write failure handling into instructions ("If a tool fails, say so. Do not invent results.");
    troubleshooting covers auth errors and silent false-success claims.
  - `fallback_config` covers LLM unavailability (fallback model/external endpoint), not tools.
  - Webhook tools: `timeout_ms` (example default 500), `async` + `async_timeout_ms`
    (fire-and-continue), `store_fields_as_variables` (persist response fields as dynamic variables).

## 4. Dynamic Webhook Variables — exact contract

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables
(cross-confirmed in create-an-assistant field docs + Edge Compute AI backend guide:
https://developers.telnyx.com/docs/edge-compute/guides/ai-assistant-backend)

- **When it fires:** at the start of a voice call; on **every turn** of SMS/chat.
- **Request:** `POST` to `dynamic_variables_webhook_url`:

```json
{
  "data": {
    "record_type": "event",
    "id": "event_12345678-90ab-cdef-1234-567890abcdef",
    "event_type": "assistant.initialization",
    "occurred_at": "2025-04-07T10:00:00Z",
    "payload": {
      "telnyx_conversation_channel": "phone_call",
      "telnyx_agent_target": "+13128675309",
      "telnyx_end_user_target": "+15551234567",
      "telnyx_end_user_target_verified": false,
      "call_control_id": "v3:u5OAKGEPT3Dx8SZSSDRWEMdNH2OripQhO",
      "assistant_id": "assistant_12345678-90ab-cdef-1234-567890abcdef"
    }
  }
}
```

  Caller number is in the **body** (`payload.telnyx_end_user_target`), not a header.
  Headers: `telnyx-signature-ed25519` (base64 Ed25519) + `telnyx-timestamp` (unix secs); signed
  message = `"{timestamp}|{raw_body}"`. Verify against `GET https://api.telnyx.com/v2/public_key`
  → `data.public` (NOT `data.public_key`), max ±5 min skew in the sample code.
- **Response** — all top-level fields optional:

```json
{
  "dynamic_variables": { "has_active_hold": true, "customer_name": "Rachel Thomas" },
  "memory": { "conversation_query": "..." },
  "conversation": { "metadata": { "customer_tier": "premium" } },
  "encrypted_dynamic_variables": { "...": "per-caller credentials" }
}
```

  `dynamic_variables` sets variable values; `memory`/`conversation` feed memory/metadata.
  **A flat response (`{"customer_name":"Jane"}`, no wrapper) is silently ignored** — the API
  reference itself flags this as a "Gotcha". Values may be JSON booleans/numbers, not only strings
  ("wrong data types" troubleshooting entry).
- **Timeout:** `dynamic_variables_webhook_timeout_ms`, default **1500 ms**, range 1–10000 ms.
  Telnyx's own Edge Compute guide recommends raising it to ~8000 ms for edge cold starts.
- **Failure behavior:** on timeout or invalid response the call proceeds best-effort — never
  fails the call. Telnyx falls back to lower-precedence sources; unresolved variables stay raw
  (`{{name}}` renders as-is in instructions/greeting; renders as empty string in speak/tool-node
  `message` fields).
- **Precedence:** 1) outbound API call (`AIAssistantDynamicVariables`) → 2) custom SIP headers
  (`X-Full-Name` → `{{full_name}}`; `X-Telnyx*` headers are NOT mapped) → 3) DV webhook →
  4) assistant-level `dynamic_variables` defaults → 5) unset (raw `{{var}}`). Variable names must
  not use reserved `telnyx_` prefix. Realtime WebSocket: pass via `session.update`.
- **Usage in workflows:** `{{var}}` in prompt/speak instructions and `message` fields;
  `{"type":"variable","name":"has_active_hold"}` as an expression operand (e.g. route on
  `customer_tier == "enterprise"` or `telnyx_conversation_duration_secs >= 300`); tool-node
  arguments filled by same-named dynamic variables; Portal gives `{{}}` autocomplete/highlight.

## 5. Version testing

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution

- **Tests:** Portal "AI Tests" page: named scenarios with success criteria against an assistant;
  run, inspect pass/fail + conversation. Assistant-tests API endpoints exist (create/run/history).
- **Versions:** any save can be "Save as New Version" with notes; up to 10 versions including
  main; oldest permanently deleted past the limit except main and rule-referenced versions.
  `conversation_flow` is versioned only as part of assistant config (not separately).
- **Traffic distribution:** ordered feature-flag-style rules. **If** = end-user-target conditions
  (`is one of`, `is not one of`, `starts with`; value = `{{telnyx_end_user_target}}`, works inbound
  and outbound), AND-joined; **Serve** = one version or **Split by percentage** across version
  slots. Percentages must sum to <100; remainder goes to main (built-in canary safety). First
  matching rule wins; unmatched → default rule (main). Rollback clears all rules; promote
  validated version to main.
- **API:** get-all-versions, get/update/delete-version, promote-version-to-main, and create/get/
  update/delete **Canary Deploy** exist in the API index — but the canary-deploy request shape was
  NOT in the fetched OpenAPI spec (no "canary" match). Conflict/open: endpoints exist, schema
  not captured.

## 6. Gotchas & platform friction (full list)

1. **Flat DV webhook response silently ignored** — `{"customer_name":"Jane"}` without the
   `dynamic_variables` wrapper produces no error; variables just stay unresolved.
2. **Default 1.5 s DV timeout vs edge cold starts** — Telnyx's Edge guide recommends ~8000 ms;
   a cold start past 1.5 s silently falls back (wrong/no personalization, call continues).
3. **DV webhook fires every turn on SMS/chat** (voice: once at call start) — unexpected volume/
   cost/latency if assumed call-start-only.
4. **System-variable list inconsistent across pages** — `telnyx_conversation_duration_secs`,
   `telnyx_last_tool_status_code`, `telnyx_end_user_target_verified` are used by workflows page
   and DV payload but absent from the dynamic-variables table.
5. **"Don't call tools" instructions silently kill LLM-edge routing on calls** — LLM conditions
   fire via `transition__<edge_id>` tool calls; forbidding tools can freeze routing while the
   model politely acknowledges. Chat has the inverse quirk: post-reply edge evaluation ignores
   instructions, so forbidding tools doesn't stop chat LLM edges.
6. **Channel-dependent condition semantics** — expression edges pre-empt LLM edges on calls
   (regardless of order); on chat an earlier-declared LLM edge can beat an expression edge that
   became true mid-turn. `telnyx_last_tool_status_code`: string on voice, number on chat — the
   same condition must differ per channel.
7. **10-version rolling deletion** — the 11th save permanently deletes the oldest version (unless
   rule-referenced). No opt-out.
8. **MCP transport `type` unvalidated in docs** — API schema is `type: string`, no enum; HTTP/SSE
   documented only in the portal guide. Trial-and-error.
9. **MCP server deletion blocked by stale references** — `DELETE /ai/mcp_servers/{id}` returns
   400 (10015) even when only old assistant version snapshots reference it; delete those
   versions too.
10. **Speak-node edge rules subtle** — exactly one default edge required (or zero if terminal);
    Portal silently makes the first edge default; extra edges fall back to LLM conditions —
    but how an LLM edge fires from a no-LLM-turn node is undocumented (test §7).
11. **Two per-node tool config mental models** — API `shared_tool_ids`+`tools_mode` (shared tools
    only) vs Portal inherited-toggles + node-only tools.
12. **Inline `tools` deprecated** in favor of `tool_ids`/shared tools; update semantics differ
    (`tools` replaces inline only; shared persist unless `tool_ids` changes).
13. **Legacy handoff trap** — assistants on the legacy handoff-tool flow show a legacy graph and
    must be migrated before building a workflow.
14. **Data locality conflicts with third-party models** — `privacy_settings.in_transit_data_locality`
    is rejected (create-time 400) if the assistant or any node override uses a third-party model.
15. **No documented phone-number→assistant binding API** — TeXML app auto-created per assistant,
    but attaching a number to it is portal-only in the quickstart; no assistant-side API documented.
16. **Docs embed `.md` variants** (llms convention) — mixed link formats inside pages; minor.

## 7. Empirical tests to run early

Derived from the open questions above — each is cheap and de-risks a core path:

1. **DV webhook happy path + flat-response trap**: deploy the Edge Function; call in; confirm
   `{"dynamic_variables":{...}}` lands; then return flat JSON once to observe silent-ignore.
2. **DV timeout**: set 1500 ms, add artificial 2 s delay in the function, confirm best-effort
   fallback and raw `{{var}}` rendering in instructions; then raise to 8000 ms and re-test.
3. **Signature verification**: replay a real DV webhook against the verifier — check
   `data.public` naming, `"{timestamp}|{raw_body}"` message, ±5 min skew behavior.
4. **Expression-edge routing on voice**: `telnyx_conversation_duration_secs >= 300` escalation
   edge and a tool-node `telnyx_last_tool_status_code` success/fail routing (confirm string vs
   number on voice; and type coercion of boolean/number DVs).
5. **LLM-edge + tool-ban interaction**: instructions that forbid tools vs an LLM edge — confirm
   routing deadlocks (or not) on voice vs chat.
6. **MCP `_meta` correlation**: verify `params._meta.telnyx_conversation_id` reaches our server;
   verify `type: "http"` is accepted by the API.
7. **Speak/tool node defaults**: build a speak node with one default edge; then add an extra
   LLM edge off a speak node in the Portal and observe runtime behavior (undocumented).
8. **Canary/version API**: hit the canary-deploy endpoint to capture its real request shape.
9. **Phone binding**: confirm whether the number-attach step has an API path (Voice/TeXML docs)
   or must be Portal-only; verify outbound `POST /v2/texml/ai_calls/{app_id}` works from the
   assistant's auto-created TeXML app.
