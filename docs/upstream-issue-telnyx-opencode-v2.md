# GitHub issue draft — team-telnyx/ai

> File at: https://github.com/team-telnyx/ai/issues/new
> Suggested title: `@telnyx/opencode` plugin fails to load on OpenCode V2 (`PluginModule.LoadError`)

---

## Summary

The `@telnyx/opencode` plugin (latest: 0.1.5) does not load on OpenCode V2. On startup the server logs a plugin load failure and skips the plugin entirely, so on V2 there is no `telnyx` provider, no `opencode auth login --provider telnyx`, and no `/telnyx` TUI command.

## Environment

- OpenCode 2.2.6 (V2) — macOS, installed via Homebrew (`opencode-v2` formula)
- `@telnyx/opencode@0.1.5` (npm latest, published 2026-06-25)
- Config: `"plugins": ["@telnyx/opencode"]` in `opencode.json`

## What happens

Server log on startup:

```
level=WARN message="failed to load plugin" target=@telnyx/opencode
cause="Cause([Fail(PluginModule.LoadError: Plugin must export a default definition
with an id and an effect or setup function. (cause: SchemaError(Expected object
at [\"default\"])))])"
```

Because the plugin never loads, the documented login command exits with CLI help instead of starting the login flow:

```
level=ERROR message="cli process failed"
cause="Cause([Fail(~effect/cli/CliError/ShowHelp: Help requested)])"
args="[\"auth\",\"login\",\"--provider\",\"telnyx\",\"--method\",\"API Key\"]"
```

## Root cause

- OpenCode V2 (released 2026-10-12) requires the new plugin API: `export default Plugin.define({ id, setup })` from `@opencode/plugin`.
- The Telnyx plugin is built on the V1 API — `@opencode-ai/plugin ^1.2.27` — exporting an async function that returns `{ auth, config, "chat.message", "chat.params" }` hooks. V2's loader expects an object at the default export, hence `SchemaError(Expected object at ["default"])`.
- All published versions (0.1.0–0.1.5) use the V1 SDK, and `main` in `plugins/opencode` still pins `@opencode-ai/plugin ^1.2.27`, so no release or branch currently supports V2.

## Suggested fix

Port to the V2 plugin API — the official migration guide covers the mapping: https://opencode.ai/docs/build/plugins/migrate-v1

Relevant mappings for this plugin:

| Current (V1)                                        | V2                                             |
| --------------------------------------------------- | ---------------------------------------------- |
| `auth` hook (provider + API-key method)             | `ctx.integration.transform(...)` / integrations |
| `config` hook (registers the `telnyx` provider)     | `ctx.provider.transform(...)`                   |
| `chat.message` / `chat.params`                      | `ctx.session.hook("prompt")` / `("context")`  |
| `src/tui.tsx` (`/telnyx` command)                   | V2 TUI plugin format                           |

The guide also documents that one package can support both lines from a single default export (V2 `Plugin.define` + V1 `server()`; V1 object entrypoints work on OpenCode ≥ 1.18.29), so a dual-compatible release may not even require forking.

## Workaround

The 1.x line is maintained in parallel and never auto-updates to 2.x:

```bash
npm install -g opencode-ai@1.19.5
opencode plugin @telnyx/opencode
opencode auth login --provider telnyx --method "API Key"
```

Happy to help test a V2 build.
