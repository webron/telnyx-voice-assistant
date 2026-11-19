# Assistant

`assistant.json` — the full assistant definition (workflow, MCP server, DV webhook).
`deploy.mjs` — idempotent create/update: POST if absent, PATCH otherwise.
`.assistant-id` — written by deploy.mjs (git-ignored? no: tracked intentionally).

Run: `node assistant/deploy.mjs`
