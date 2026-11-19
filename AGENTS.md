# Telnyx Voice Assistant — coding challenge

Interview assignment for Telnyx: an AI voice assistant built on Telnyx AI Assistants
(Conversation Workflows), a custom MCP server, Dynamic Webhook Variables, and Edge
Compute (Edge Functions, KV, Stateful Actors), with observability and a public
deployment. The full brief was provided as a secret gist — never commit or publish
the gist URL or its verbatim text.

## Requirements checklist (from the brief)

1. **Assistant + Conversation Workflow** — multi-node: prompt nodes, at least one
   speak node (verbatim/compliance), conditional edges (LLM conditions and variable
   comparisons); callable by phone.
2. **Custom MCP server** — 3+ meaningful tools, publicly accessible, called from
   workflow nodes.
3. **Dynamic Webhook Variables** — webhook endpoint deployed as an Edge Function,
   feeding live data into conversation and routing.
4. **Edge Compute** — (a) Edge Functions via `telnyx-edge ship`; (b) KV for session
   state, caching, or feature flags; (c) at least one Stateful Actor owning
   per-entity state with a genuine read-modify-write (single-threaded execution).
5. **Observability** — structured logs on every webhook call, one signal beyond
   logs (counter/latency/trace), README explains how we'd detect breakage within a
   minute; keep evidence of one real debugging trail.
6. **Telnyx Inference via the `@telnyx/opencode` plugin** — all coding work in this
   repo is done by OpenCode agents powered by Telnyx-hosted LLMs (Kimi-K3 /
   GLM-5.x / DeepSeek-V4 / Qwen / MiniMax families).
7. **Public deployment + docs** — working URLs and phone number; README with setup,
   architecture diagram (Assistant → Workflow → Edge Function → KV/Actor → MCP),
   observability story, demo script; `opencode.json` showing the Telnyx plugin active.

## Environment facts (verified 2026-11-09)

- Agent sessions for this project run on **OpenCode V1.19.5**. The
  `@telnyx/opencode` plugin (0.1.5) is built on the V1 plugin API and does not load
  on OpenCode V2 (new plugin API since 2026-10-12). V2 remains installed at
  `/opt/homebrew/bin/opencode` and as the desktop app; both versions coexist.
- `opencode` on PATH is a **wrapper script** (`~/.local/bin/opencode`) that sets
  `XDG_DATA_HOME=~/.local/share-opencode-v1` so V1's database stays separate from
  V2's (`~/.local/share/opencode/opencode.db` — the schemas are incompatible).
  Never run `npm install -g opencode-ai` without re-applying the wrapper afterward;
  it would restore the plain symlink and break the DB isolation.
- The plugin is installed globally (`plugin` key in `~/.config/opencode/opencode.json`
  and `tui.json`). The leftover V2 `plugins` key fails harmlessly on V2.
- The Telnyx API key is stored via `opencode auth login --provider telnyx
  --method "API Key"` (never in git). Enabled-model allowlist:
  `~/.config/opencode/telnyx-models.json`. Web UI: `opencode web` from the repo
  root; the `/telnyx` model manager is TUI-only.
- Telnyx account tier gates the AI products: Inference and AI Assistants require
  Trial tier or higher. If API calls fail with error 10038 ("Feature not
  permitted at this account level"), the account tier is the cause — see
  Account matters are handled by the repo owner, not by the agent.

## Repo layout

- `docs/requirements.md` — requirements tracker: status per requirement (R1–R7),
  deferred bonus list, test matrix, open decisions. Update statuses as work lands;
  requirements first, bonuses only after R1–R7 are verified.
- `docs/upstream-issue-telnyx-opencode-v2.md` — GitHub issue draft for team-telnyx/ai
  (plugin fails to load on V2 with `PluginModule.LoadError`); intended to be committed.
  git-ignored — never commit or publish it.

## Working agreement

- Commit early and often — this repo is the submission artifact.
- Secrets (API keys, `.env`) never enter git.
- Instrument while building — structured logs first, not after something breaks.
- Test every workflow path: happy, fallback, escalation, and a negative case.

## Delegation (research & bulk work)

- Delegate doc research and bulk/mechanical work to parallel subagents with
  tight briefs; keep the main session for decisions, judgment, and verification.
- Each agent writes its own notes to `docs/inbox/<topic>.md` and reports a
  digest only (answers + source URLs + gotchas + open questions). The main
  session merges what matters into `docs/research/*.md` — raw doc dumps never
  enter the main context.
- Agents write files but never run git commands; the main session reviews and
  commits.
- Verify agent claims against the cited source before relying on them in
  architecture decisions.
