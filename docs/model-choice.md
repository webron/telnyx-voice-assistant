# Model choice — Telnyx-hosted models for this build

Decision record for which Telnyx-hosted inference models power the OpenCode agent
work on this repo, and why. Pricing pulled live from `GET /v2/ai/models` on
2026-11-09 (USD per 1M tokens). The account had limited credit while writing this,
so the strategy optimizes cost per task.

## The workload phases

1. **Research & planning** — reading Telnyx docs (Edge Functions, KV, Stateful
   Actors, Conversation Workflows, Dynamic Variables, MCP), synthesizing into
   design docs. Input-heavy, moderate output, quality of *comprehension* matters
   more than peak reasoning.
2. **Build** — writing the MCP server, Edge Function code, workflow JSON.
   Code quality matters; context grows with the repo.
3. **Debugging** — reasoning-heavy, small context.

## The candidates (Telnyx-hosted, text models)

| Model | Params | Context | Max out | Input | Cached in | Output | Notes |
|---|---|---|---|---|---|---|---|
| `zai-org/GLM-5.3-Flash` | 320B | 1M | — | $0.135 | $0.027 | $0.45 | newest GLM flash tier |
| `deepseek-ai/DeepSeek-V4-Flash-0731` | 284B | 1M | — | $0.13 | $0.03 | $0.26 | cheapest output |
| `poolside/Laguna-S-2.1` | 118B | 1M | — | $0.10 | $0.02 | $0.20 | code-specialist vendor |
| `openai/gpt-oss-120b` | 117B | 131K | — | $0.068 | $0.03 | $0.30 | cheapest overall; small ctx |
| `MiniMaxAI/MiniMax-M3-MXFP8` | 428B | 1M | — | $0.27 | $0.08 | $1.10 | |
| `deepseek-ai/DeepSeek-V4.1-Flash` | 552B | 1M | 64K | $0.30 | $0.006 | $1.20 | best cache price |
| `moonshotai/Kimi-K2.6` | 1T | 262K | — | $0.665 | $0.08 | $4.00 | has `no-thinking` variant |
| `zai-org/GLM-5.2` | 754B | 1M | 131K | $1.00 | $0.20 | $4.00 | has `no-thinking` variant |
| `zai-org/GLM-5.3` | 753B | 1M | — | $1.25 | $0.24 | $4.00 | flagship GLM |
| `moonshotai/Kimi-K3.1-Pro` | 2.8T | 1M | 64K | $2.00 | $0.20 | $10.00 | flagship, cheaper than K3 |
| `moonshotai/Kimi-K3` | 2.8T | 1M | 64K | $2.70 | $0.27 | $13.50 | flagship, the brief's example |

(Also on the account but gated by the plugin's allowlist behavior or unsuitable:
`Qwen/Qwen3.8-27B`, `gemma-4-*-it`, `Llama-3.3-70B-Instruct` — smaller open
models with weaker instruction-following for agentic work.)

## The choice

- **Default for research/planning and most build work: `zai-org/GLM-5.3-Flash`.**
  320B parameters is a serious model, 1M context swallows whole doc pages plus
  repo state, and the price ($0.135/$0.45) is ~20x cheaper than Kimi-K3 input and
  ~30x cheaper on output. For doc reading and synthesis this is the right tier.
- **Flagship for hard reasoning: `moonshotai/Kimi-K3`** (or `Kimi-K3.1-Pro`,
  which is newer and cheaper). Use surgically: architecture decisions, nasty
  bugs, final design review. Notably Kimi-K3 emits reasoning tokens by default
  (billed at output rate — $13.50/1M), so reserve it for questions that deserve it.
- **Scratch/throwaway: `deepseek-ai/DeepSeek-V4-Flash-0731` or
  `poolside/Laguna-S-2.1`** when the task is mechanical.

Set per session in the OpenCode model picker; the project default lives in
`opencode.json` (`model` field).

## Cost reality check

for prefix cache hits, and repeated turns are exactly that.

A heavy planning session on GLM-5.3-Flash — say 300K input tokens (half cached),
30K output — costs about **$0.06**. The same session on Kimi-K3 costs about
**$1.20** for the same session.

## Working rules (cost discipline)

1. Distill docs into `docs/research/*.md` early, then work from the notes —
   never re-read full doc pages across sessions.
2. Keep sessions focused: one topic per session, notes to file, then close.
3. Flash by default; flagship only when Flash demonstrably struggles.
4. 