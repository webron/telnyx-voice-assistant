# Research notes: AI Assistants + Conversation Workflows + Dynamic Webhook Variables

Researched 2026-11-09. Sources fetched from developers.telnyx.com (live). Raw OpenAPI spec for
`create-an-assistant` was fetched in full (saved from fetch output); all other claims below trace to
the linked page.

Primary sources:

- Workflows: https://developers.telnyx.com/docs/inference/ai-assistants/workflows
- Dynamic Variables: https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables
- Integrations: https://developers.telnyx.com/docs/inference/ai-assistants/integrations
- Version testing: https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution
- API reference (create assistant): https://developers.telnyx.com/api-reference/assistants/create-an-assistant
- MCP servers on assistants: https://developers.telnyx.com/docs/development/mcp/assistant-mcp-servers
- MCP server API: https://developers.telnyx.com/api-reference/mcp-servers/create-mcp-server
- Voice Assistant Quickstart: https://developers.telnyx.com/docs/inference/ai-assistants/no-code-voice-assistant
- Edge Compute AI backend guide: https://developers.telnyx.com/docs/edge-compute/guides/ai-assistant-backend
- Docs index: https://developers.telnyx.com/llms.txt (per-section indexes under /public/llms/)

All primary URLs returned 200. No 404s except a guessed path
(`/docs/inference/ai-assistants/mcp` — the real MCP guide lives under `/docs/development/mcp/assistant-mcp-servers`).

---

## 1. Creating an assistant: Portal vs API, and phone binding

**API create call.** `POST https://api.telnyx.com/v2/ai/assistants` (Bearer API key; optional
`Idempotency-Key` header for safe retries). Required fields: `name`, `instructions`. Everything
else is optional and defaults apply.
Source: https://developers.telnyx.com/api-reference/assistants/create-an-assistant

Key fields on `CreateAssistantRequest` (same URL):

- `model` — model ID used when `external_llm` is not set. If neither `model` nor `external_llm` is
  provided, Telnyx applies the default model (the quickstart says the default is
  `zai-org/GLM-5.3-Flash` — source: no-code-voice-assistant page, "Supported language models").
- `instructions` — system instructions; may be templated with dynamic variables (`{{...}}`).
- `greeting` — templated text; empty string = wait for user to speak first; special value
  `<assistant-speaks-first-with-model-generated-message>` = model-generated greeting.
- `voice_settings` — TTS config: `voice` (e.g. `Telnyx.KokoroTTS.af_heart` format; ElevenLabs via
  `api_key_ref`; Soniox `Soniox.tts-rt-v2.<voice_id>`; MiniMax `language_boost`), `voice_speed`
  (0.6–1.5 for Telnyx Ultra), `api_key_ref` (integration secret for third-party TTS), plus
  ElevenLabs-only knobs (`temperature`, `similarity_boost`, `use_speaker_boost`, `style`, `speed`),
  `expressive_mode`, background audio. Source: create-an-assistant spec (`VoiceSettings` schema) +
  no-code-voice-assistant page (TTS providers: Telnyx, AWS, Azure, ElevenLabs, Inworld).
- `transcription` — STT config (`model` e.g. `deepgram/flux`, language, region, endpointing
  settings).
- `telephony_settings` — `default_texml_app_id` ("Default Texml App used for voice calls with your
  assistant. This will be created automatically on assistant creation"), `time_limit_secs`
  (max call duration, default 1800), `user_idle_timeout_secs`, noise suppression
  (`aicoustics`/`krisp`/`deepfilternet`/`disabled`), recording settings, voicemail detection,
  `supports_unauthenticated_web_calls`.
- `messaging_settings` — `default_messaging_profile_id`, `conversation_inactivity_minutes`,
  `delivery_status_webhook_url` (SMS/WhatsApp chat side of the assistant).
- `mcp_servers` — array of `{id, allowed_tools?}` referencing servers created via `/ai/mcp_servers`.
- `tool_ids` / `tools` — shared tools (preferred) vs deprecated inline tools.
- `dynamic_variables` — map of variable name → default value.
- `dynamic_variables_webhook_url` + `dynamic_variables_webhook_timeout_ms` — see §4.
- `conversation_flow` — the workflow graph, see §2.
- `enabled_features` — e.g. `TELEPHONY` (per PHP sample); also `insight_settings`,
  `privacy_settings`, `observability_settings`, `widget_settings`, etc.

**Phone binding / callability.**
- Inbound: in the Portal, the assistant creation flow has an "(Optional) Assign a phone number"
  step — attach a purchased Telnyx number with voice features to the assistant; you can also skip
  and assign later. Source: no-code-voice-assistant page.
  Under the hood, each assistant gets a TeXML app auto-created (`telephony_settings.default_texml_app_id`,
  "created automatically on assistant creation" — create-an-assistant spec). There is a
  `GET /ai/assistants/{assistant_id}/texml` ("Get an assistant texml") reference in the API index
  (https://developers.telnyx.com/public/llms/ai/assistants.txt → get-assistant-texml).
- Outbound via API: `POST https://api.telnyx.com/v2/texml/ai_calls/<texml_app_id>` with
  `From`, `To`, `AIAssistantId` (and optional AMD params). Source: no-code-voice-assistant page.
- Programmatic inbound: Call Control "Start AI Assistant" command on a call leg.
  Source: https://developers.telnyx.com/api-reference/call-commands/start-ai-assistant.md (referenced
  from no-code-voice-assistant page; not fetched in detail this session).

**Assessment of the API surface for our build:** the create-assistant payload can carry the entire
system in one call (model, instructions, voice, TeXML app, MCP servers, tools, workflow graph,
dynamic-variable webhook URL). The Portal is the same configuration with a canvas editor for the
workflow.

---

## 2. Conversation Workflows

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/workflows
Schema details: `ConversationFlow`, `FlowNodeReq`/`SpeakNodeReq`/`ToolNodeReq`, `FlowEdge`,
`LLMCondition`, `ExpressionCondition`, `DefaultCondition`, `Expression`/`ComparisonExpression`/
`BooleanOpExpression`/`ArithmeticExpression` in the create-an-assistant OpenAPI spec (URL in §1).

**Storage & shape.** The workflow is a directed graph stored on the assistant as
`conversation_flow: {start_node_id, nodes[], edges[]}`. Node and edge IDs are caller-supplied
strings. Validation enforces unique IDs, `start_node_id` referencing a real node, and edge
endpoints referencing real nodes. `edges` may be empty for a single-node flow. Updates are
atomic: omit `conversation_flow` to leave it unchanged, send `conversation_flow: null` to clear it.
To change one node or edge you resend the whole graph. Position `{x,y}` fields exist purely for
authoring UIs and round-trip.

**Node types (3):**

1. **Prompt node** (`type: "prompt"`, default) — LLM-driven step. Fields: `id`, `instructions`
   (required), `name`, `instructions_mode` (`replace` default | `append` — append concatenates node
   instructions after assistant instructions), `model` / `llm_api_key_ref` / `external_llm` (LLM
   bundle override: set ANY of the three and all three come from the node), `shared_tool_ids` +
   `tools_mode` (`replace` default | `append`) for per-node tool scoping, `voice_settings` (unset
   fields cascade), `transcription` override, `position`.
2. **Speak node** (`type: "speak"`) — deterministic, no LLM turn. Fields: `id`, `message` (required,
   delivered verbatim, supports `{{variable}}` interpolation; unresolved placeholder renders as
   empty string), `name`, `position`. No SSML is documented — plain templated text only. In the
   Portal, Ultra and xAI Grok voices support inline SSML emotion tags and nonverbal cues like
   `[laughter]` (that is a TTS feature, not a speak-node schema field) — source:
   no-code-voice-assistant page.
3. **Tool node** (`type: "tool"`) — deterministic, no LLM turn. Fields: `id`, `shared_tool_id`
   (required — references an org-level shared tool), optional `message` announcement spoken BEFORE
   the tool runs (so the tool result is not available in it), `name`, `position`. Arguments are
   resolved from the conversation's dynamic variables by name — a dynamic variable whose name
   matches a tool parameter supplies that argument. Reaching the node executes the tool
   immediately.

Special tool-node rules: hangup tool node ends the call and accepts no outgoing edges; transfer
tool node accepts at most one outgoing default edge (used only if the transfer fails).

**Edges.** `FlowEdge = {id, start_node_id, target, condition}`. Target: `{type:"node",
node_id}` or `{type:"assistant", assistant_id, voice_mode: unified|distinct, position}`. Condition
discriminated by `type`:

- `llm` — `{type:"llm", prompt: "<natural language>"}`. **On calls**: each LLM edge leaving the
  active node is offered to the model as a tool named `transition__<edge_id>` with the prompt as
  description; the edge fires only when the model selects that tool in the same turn as the reply.
  **On chat channels**: after the reply, a separate model call evaluates every outgoing LLM edge as
  statements and the first true verdict in declaration order wins.
- `expression` (variable comparison) — `{type:"expression", expression: <Expression AST>}`. The
  AST variants: `comparison` (`op` ∈ `==`, `!=`, `<`, `<=`, `>`, `>=`, `contains`, `not_contains`;
  `contains`/`not_contains` apply to strings as substring and arrays as membership), `bool_op`
  (`and`/`or` n-ary ≥2 operands, `not` unary), `arithmetic` (`+`, `-`, `*`, `/`, `%`), operands of
  `variable` (`{type:"variable", name:"..."}`), `number_literal`, `string_literal`,
  `bool_literal`. Example: `{"type":"expression","expression":{"type":"comparison","op":">=","left":{"type":"variable","name":"telnyx_conversation_duration_secs"},"right":{"type":"number_literal","value":300}}}`.
  There is no string-form expression language — it is a structured AST. The workflows doc's
  shorthand `telnyx_conversation_duration_secs >= 300` is prose for the AST.
- `default` — `{type:"default"}`. Fires only when no other outgoing edge matched. **Valid only on
  edges leaving speak or tool nodes.** A speak node must have exactly one outgoing default edge; a
  tool node with any outgoing edges must have exactly one default edge among them (a tool node with
  no outgoing edges is a valid terminal step).

**Evaluation order (critical semantics).**
- Variable-comparison edges are evaluated by Telnyx in `edges` declaration order; first true wins.
- The default edge is always considered last regardless of position in the array.
- On calls, expression conditions are evaluated BEFORE the model turn and pre-empt LLM edges
  regardless of declaration order — a matching expression edge moves the conversation before the
  model sees any transition tools. So expression > LLM on calls always.
- On chat channels, an expression edge true when the turn begins routes before the reply; after the
  reply, remaining conditioned edges are considered together in declaration order (so an LLM edge
  declared earlier can win over an expression edge that became true mid-turn).
- Among LLM edges on calls, the model chooses (declaration order is only the order tools are
  offered); on chat, first true in declaration order.

**System variables** (dynamic-variables page; more in no-code-voice-assistant page):

- `telnyx_current_time` (+ IANA-timezone variants like `telnyx_current_time_America/New_York`,
  shorthands `telnyx_current_date`, `telnyx_current_time_of_day`, `telnyx_current_weekday`,
  `telnyx_current_month`, `telnyx_current_day`, `telnyx_current_year`, and a `date` strftime filter:
  `{{ telnyx_current_time | date: "%I:%M %p", "America/New_York" }}`)
- `telnyx_conversation_channel` — `phone_call` | `web_call` | `sms_chat`
- `telnyx_agent_target`, `telnyx_end_user_target`
- `telnyx_shaken_stir_attestation` — `a` | `b` | `c`
- `call_control_id`
- `telnyx_sip_header_user_to_user`, `telnyx_sip_header_diversion` (quickstart page only)
- `telnyx_last_tool_status_code` — set by tool nodes; compared in expression edges. On voice it is
  a **string** (`"200"`), on chat a **number** (`200`).
- `telnyx_conversation_duration_secs` — used in workflows examples (`>= 300` escalation pattern);
  NOT listed in the dynamic-variables system-variable table (see Gotchas).
- `telnyx_end_user_target_verified` — present in the DV webhook payload (STIR/SHAKEN full-A
  verification); also not in the system-variable table.
- `telnyx_conversation_id` — set by the platform; delivered via DV webhook payload and via
  `_meta` on MCP tool calls (no-code-voice-assistant page).

**Versioning.** Assistant saves create versions (portal "Save as New Version" or API writes); each
assistant keeps up to 10 versions including main; oldest are permanently deleted once the limit is
exceeded, except main and versions referenced by traffic-distribution rules.
`conversation_flow` itself is not separately versioned — it is part of the assistant config that
gets versioned. Sources: version-testing-traffic-distribution page; API endpoints list-all-versions /
get-version / promote-version (public/llms/ai/assistants.txt index).

**Assistant-to-assistant routing.** An edge can target another assistant (`AssistantTarget`);
the active assistant on the conversation is rewritten and the target assistant's flow starts at its
own `start_node_id`. `voice_mode: distinct` gives the target its own voice.

---

## 3. Tools & MCP

**Configuration path.** Create an MCP server at account level (`POST /ai/mcp_servers` with
`name`, `type`, `url`, optional `api_key_ref` (integration-secret identifier), optional
`allowed_tools`) — source: https://developers.telnyx.com/api-reference/mcp-servers/create-mcp-server.
Then attach it to the assistant via `mcp_servers: [{id, allowed_tools?}]` on create/update — the
per-assistant `allowed_tools` list overrides the server-level allowlist when present (same URL).

**Transports.** The Portal guide documents **HTTP** and **SSE** as the Type options
(assistant-mcp-servers page, "Configure the server connection" table). `stdio` is not offered —
there is no local-process transport for assistant-attached MCP servers (expected, since execution is
hosted). The API spec's `type` field is a plain string with **no documented enum** — allowed values
are only discoverable via the portal docs. Gotcha noted in §6.

**Auth.** API key stored as an Integration Secret and referenced by `api_key_ref`. If the endpoint
URL itself is a credential, the URL can also be stored as an integration secret and referenced
("+ Append integration secret" under the URL field). No custom per-request headers in the server
config; for per-caller credentials (e.g., a bearer token that differs per caller), return them in
`encrypted_dynamic_variables` from the DV webhook — source: dynamic-variables page +
https://developers.telnyx.com/docs/inference/ai-assistants/per-caller-credentials.md (referenced;
not fetched in depth). A `Tool timeout (ms)` per server caps a single tool call.

**Tool scoping per node.** Assistant-level: all tools configured once on the assistant. Node-level
(API): `shared_tool_ids` + `tools_mode` (`replace` = only the node's tools callable; `append` =
added to assistant's tools). Portal: each node's Tools tab shows inherited tools with per-node
toggles (enabled by default) plus "Added for this node" tools that exist only on that node.

**MCP context injection.** Telnyx adds `telnyx_conversation_id` on the `_meta` field of every MCP
tool call (JSON-RPC `params._meta.telnyx_conversation_id`), so our MCP server can correlate and
per-call-control state. It's platform-set, not model-set, so it isn't prompt-injectable.
Source: no-code-voice-assistant page, MCP section.

**Failure behavior.**
- Tool nodes: HTTP status lands in `telnyx_last_tool_status_code`, and you route success/failure
  with expression + default edges. That's the deterministic path.
- Prompt-node tool calls (model-invoked): no documented automatic fallback or retry. The MCP guide
  instructs you to write failure handling into instructions ("If a tool fails, say so. Do not
  invent results."). The troubleshooting table covers auth errors and silent false-success claims —
  i.e., failure handling is your job at the prompt level.
- `fallback_config` is for the **LLM** being unavailable (fallback model / external endpoint), not
  tool failures.
- Webhook tools carry `timeout_ms` (example default 500 in the PHP sample), `async` +
  `async_timeout_ms` for fire-and-continue behavior (async-tools guide exists:
  https://developers.telnyx.com/docs/inference/ai-assistants/async-tools.md), and
  `store_fields_as_variables` to persist response fields into dynamic variables.

---

## 4. Dynamic Webhook Variables (the exact contract)

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/dynamic-variables
Cross-confirmed: create-an-assistant spec (`dynamic_variables_webhook_url` field docs carry an
explicit gotcha), Edge Compute AI backend guide.

**When it fires:** at the start of a voice call; on **every turn** of an SMS or chat conversation.

**Request:** `POST` to `dynamic_variables_webhook_url`. JSON body:

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

The caller number is in the **body** (`payload.telnyx_end_user_target`), not a custom header.
Headers: `telnyx-signature-ed25519` (base64 Ed25519 signature) and `telnyx-timestamp` (unix
seconds); the signed message is `"{timestamp}|{raw_body}"`. Verify against the org public key from
`GET https://api.telnyx.com/v2/public_key` → `data.public` (not `data.public_key`), max ±5 min skew
per the sample. Source: ai-assistant-backend guide; general webhook-signing docs referenced from
dynamic-variables page.

**Response:** JSON with all top-level fields optional:

```json
{
  "dynamic_variables": { "has_active_hold": true, "customer_name": "Rachel Thomas" },
  "memory": { "conversation_query": "..." },
  "conversation": { "metadata": { "customer_tier": "premium" } },
  "encrypted_dynamic_variables": { "...": "per-caller credentials (see per-caller-credentials)" }
}
```

`dynamic_variables` sets variable values; `memory`/`conversation` feed the memory system and
conversation metadata (memory doc: https://developers.telnyx.com/docs/inference/ai-assistants/memory.md).
**A flat response object (`{"customer_name": "Jane"}` without the wrapper) is silently ignored** —
the API reference itself flags this as a "Gotcha". Values can be JSON booleans/numbers, not only
strings (the "wrong data types" troubleshooting entry warns about mismatched types).

**Timeout:** `dynamic_variables_webhook_timeout_ms`, default **1500 ms**, allowed range 1–10000 ms.
On timeout (or invalid response), the call proceeds **best-effort** — it does not fail: Telnyx
falls back to the lower-precedence sources (below) and any unresolved variable stays as its raw
`{{name}}` (renders as-is, not empty, in instructions/greeting; in speak/tool-node `message`
fields, unresolved placeholders render as empty string).

**Resolution precedence:** 1) outbound API call (`AIAssistantDynamicVariables`) → 2) custom SIP
headers (`X-Full-Name` → `{{full_name}}`; `X-Telnyx*` headers are NOT mapped) → 3) DV webhook →
4) assistant-level defaults (`dynamic_variables` map) → 5) unset (raw `{{var}}`). Variable names
must not use the reserved `telnyx_` prefix. On realtime WebSocket, pass via `session.update`.

**How variables are referenced in workflows:**
- In prompt/speak instructions and speak/tool-node `message` fields: mustache `{{variable_name}}`.
- In expression (variable-comparison) edges: `{"type":"variable","name":"has_active_hold"}` as the
  expression operand — e.g. route on `customer_tier == "enterprise"` or
  `telnyx_conversation_duration_secs >= 300`.
- In tool-node arguments: a dynamic variable whose name equals a tool parameter fills that argument.
- Portal: autocomplete + inline highlighting for `{{vars}}` in the workflow editor.

---

## 5. Version testing / traffic distribution

Doc: https://developers.telnyx.com/docs/inference/ai-assistants/version-testing-traffic-distribution

- **Tests:** Portal "AI Tests" page defines named test scenarios with success criteria against an
  assistant; run and inspect pass/fail plus the conversation. (API: the assistant-tests endpoints
  exist in the API index — create-test, run, history.)
- **Versions:** any save can be "Save as New Version" with notes; 10-version retention (see §2).
- **Traffic distribution:** ordered routing rules (feature-flag style). Each rule: **If** =
  end-user-target conditions (`is one of`, `is not one of`, `starts with`; same value as
  `{{telnyx_end_user_target}}`, works inbound and outbound) AND-joined; **Serve** = one version or
  **Split by percentage** across version slots. Percentages must sum to <100; the remainder goes to
  the **main version** (built-in canary safety). First matching rule wins; unmatched traffic goes to
  the default rule (main by default). Drag to reorder; **Rollback** clears all rules; promote a
  validated version to main when ready.
- **API:** version + canary endpoints exist — get-all-versions, get/update/delete-version,
  promote-version-to-main, and create/get/update/delete **Canary Deploy** (API index:
  public/llms/ai/assistants.txt). The canary-deploy request shape is NOT in the
  inference-embedding OpenAPI spec I fetched (no "canary" match) — the endpoints exist but their
  request schema wasn't in this spec file. Flag as an open question (§7).

---

## 6. Gotchas and DevEx friction

1. **Flat DV webhook response is silently ignored.** Returning `{"customer_name": "Jane"}` instead
   of `{"dynamic_variables": {...}}` produces no error — variables just stay unresolved. The API
   reference docs flag this themselves ("**Gotcha:**"). Easy to hit, hard to debug. (Source: create-an-assistant API docs.)
2. **Default 1.5 s DV timeout is tight for edge cold starts.** Telnyx's own Edge Compute guide
   recommends raising it to ~8000 ms (max 10000). A cold-start exceeding 1.5 s silently falls back
   to defaults — call continues with wrong/no personalization. (Sources: dynamic-variables, ai-assistant-backend.)
3. **DV webhook fires every turn on SMS/chat** (not just at conversation start) — an easy source of
   unexpected webhook volume/cost/latency. Voice = once at call start.
4. **System-variable list is inconsistent across pages.** `telnyx_conversation_duration_secs`,
   `telnyx_last_tool_status_code`, and `telnyx_end_user_target_verified` are used by the workflows
   page and webhook payload but are absent from the dynamic-variables system-variable table.
   Discovering them requires cross-reading two pages. (Sources: workflows vs dynamic-variables.)
5. **"Don't call tools" instructions silently kill LLM-edge routing on calls.** LLM conditions fire
   via a tool call (`transition__<edge_id>`), so instructions like "never use the transfer tool"
   can stop workflow routing while the model politely acknowledges the request. Even naming one
   tool isn't safe. Telnyx documents this prominently (a good sign) but it's a real trap. Chat
   channels have the inverse quirk: the post-reply edge-evaluation call ignores instructions, so
   forbidding tool calls doesn't stop chat LLM edges. (Source: workflows, LLM conditions + warning.)
6. **Channel-dependent condition semantics.** Expression edges pre-empt LLM edges on calls
   (regardless of array order), but on chat an LLM edge declared earlier can beat an expression
   edge that became true mid-turn. And `telnyx_last_tool_status_code` is a string on voice, a
   number on chat — the same condition must be written differently per channel. (Source: workflows
   + FlowEdge/DefaultCondition schema descriptions.)
7. **10-version rolling deletion.** Save your 11th version and the oldest is gone permanently
   (unless referenced by a traffic rule). No opt-out. (Source: version-testing page.)
8. **MCP transport `type` is unvalidated by the docs** — the API schema is `type: string` with no
   enum; HTTP/SSE is only documented in the portal guide. Trial-and-error required.
   (Source: create-mcp-server spec vs assistant-mcp-servers guide.)
9. **MCP server deletion is blocked by stale references** — `DELETE /ai/mcp_servers/{id}` returns
   400 (10015) even when only old assistant *version snapshots* still reference the server; you
   must delete the versions too. (Source: no-code-voice-assistant page, MCP section.)
10. **Speak-node edge rules are subtle**: exactly one default edge required (or zero, if terminal);
   the Portal silently creates the first edge as default; extra edges fall back to LLM conditions —
   but how an LLM edge can fire from a node with no model turn is not explained (see Open questions).
11. **Two config places for tools per node** (API `shared_tool_ids`+`tools_mode` vs Portal
   inherited-toggles + node-only tools) — same feature, two mental models; the API path requires
   everything to be a *shared* tool.
12. **Inline `tools` is deprecated** in favor of `tool_ids`/shared tools, and update semantics
   differ (`tools` array replaces inline tools only; shared tools persist unless `tool_ids`
   changes). Migration friction documented in the Tools Library guide.
    (Source: create-an-assistant spec, `AssistantTools` description.)
13. **Legacy handoff trap**: assistants still on the legacy handoff-tool flow show a legacy graph in
   the Portal and must be migrated before building a workflow. (Source: workflows page warning.)
14. **Data locality + third-party models conflict**: enabling
   `privacy_settings.in_transit_data_locality` is rejected if the assistant (or any node override)
   uses a third-party model — a create-time 400 that couples privacy config with model choice.
    (Source: create-an-assistant spec, 400 response description.)
15. **No phone-number→assistant binding API documented in the Assistants surface.** The TeXML app is
   auto-created per assistant, but the step that attaches a purchased number to it (portal-only in
   the quickstart) has no documented assistant-side API call. Presumably via the general
   phone-number voice-config API, but that linkage isn't in these docs (see Open questions).
16. **Versioned docs drift**: docs embed `.md` variants (llms convention: append `.md` for clean
   markdown) — links inside pages sometimes mix formats. Minor, but worth knowing when automating.

---

## 7. Open questions

1. **Programmatic phone-number binding to an assistant**: the Portal assigns numbers; the API side
   shows `telephony_settings.default_texml_app_id` (auto-created) and outbound `POST /v2/texml/ai_calls/{app_id}`.
   Where is the documented API to point an inbound number at the assistant's TeXML app? Likely the
   phone-number voice-connections/TeXML-app API, not the Assistants API. Needs a follow-up check
   (probably in the Voice/TeXML docs, out of this topic's scope).
2. **MCP tool-call failure semantics on prompt nodes**: is the error text fed back to the model as a
   tool result? Retries? Only "instruct the assistant to handle failures" is documented. Needs
   empirical testing.
3. **Canary deploy API request shape** (percentages, version IDs): endpoints exist in the API index
   but the fetched spec had no canary schemas. Check the dedicated spec or portal first.
4. **Speak nodes with additional LLM edges**: the portal permits extra LLM-condition edges off a
   speak node (after its mandatory default edge), but the runtime behavior of an LLM condition on a
   no-LLM-turn node is undocumented.
5. **Max workflow size** (node/edge count, nesting depth of expression AST) is undocumented.
6. **`dynamic_variables` values typing**: examples show strings; booleans/numbers appear
   (`has_active_hold`-style checks and `telnyx_last_tool_status_code` on chat being numeric) — the
   exact coercion rules for comparisons (string "200" vs number 200) deserve a live test.
7. **Whether tool nodes support `expression` edges in the Portal UI** (docs say Portal orients
   tool-node edges around `telnyx_last_tool_status_code` comparisons, which matches expression
   conditions; but the two first-edge behaviors differ between voice and chat channels).
