# AGENTS.md

## Project

`codex-kimi-bridge` is a local Codex plugin plus MCP bridge. Its purpose is to let Codex act as planner/reviewer while Kimi Code performs implementation through the local Kimi server.

Default workspace:

```text
/Users/ximenchuifeng/Coding/codex-kimi-bridge
```

Related Kimi Code source checkout:

```text
/Users/ximenchuifeng/Coding/BigWave/kimi-code
```

## Collaboration Rule

The preferred workflow is:

1. Codex writes the spec and plan.
2. Codex delegates implementation to Kimi through `kimi_delegate_and_wait`.
3. Kimi changes code and runs verification.
4. Codex reviews the embedded `reviewPackage`, independently verifies, and either accepts or sends follow-up feedback.

Do not manually implement feature work in Codex when the user says execution should happen in Kimi. Codex may still do small local maintenance tasks when explicitly asked, such as reinstalling the plugin, committing already-reviewed work, or writing this file.

Reusable prompt templates live in:

```text
docs/prompts/kimi-delegate-workflow.md
```

## Current Plugin State

Local marketplace:

```text
/Users/ximenchuifeng/Coding/codex-kimi-bridge/.agents/plugins/marketplace.json
```

Plugin id:

```text
kimi-delegate@codex-kimi-bridge-local
```

MCP config:

```text
plugins/kimi-delegate/.mcp.json
```

The plugin MCP server currently launches:

```text
node /Users/ximenchuifeng/Coding/codex-kimi-bridge/dist/index.js
```

After code changes that affect MCP tools or plugin config, run:

```bash
pnpm build
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Then open a new Codex thread or restart Codex if the tool list does not refresh.

## Kimi Server

Default server:

```text
http://127.0.0.1:58627
```

Recommended daily setup:

```bash
kimi server install
kimi server start
```

The bridge can also auto-start Kimi with:

```bash
kimi server run --keep-alive
```

Token resolution order:

1. `KIMI_SERVER_TOKEN`
2. `$KIMI_CODE_HOME/server.token`
3. `~/.kimi-code/server.token`

Do not commit real tokens. `.mcp.json` keeps `KIMI_SERVER_TOKEN` empty.

## Useful Kimi Delegate Tools

Use these from Codex when the plugin is loaded:

- `kimi_bridge_status`: live read-only diagnostics; does not auto-start, refresh token, or update cache.
- `kimi_recent_sessions`: list recent Kimi sessions; use this first when a previous delegate was interrupted or you suspect a duplicate/running/aborted session.
- `kimi_delegate_task`: start a Kimi task from a Codex spec/plan.
- `kimi_delegate_and_wait`: preferred one-call flow; delegates, waits, and returns `reviewPackage` when idle.
- `kimi_wait_until_idle`: wait for Kimi to finish or report approval/question blocking.
- `kimi_get_handoff`: summarize Kimi output, changed files, and diffs.
- `kimi_review_package`: re-fetch a structured review package for an existing session.
- `kimi_get_diff`: inspect a specific file diff.
- `kimi_continue_task`: send review feedback or follow-up work to an existing Kimi session.
- `kimi_abort`: abort a Kimi session.

Delegate and review tools return `webUrl`, which can be opened in Kimi Web to watch the session.

## Handling interrupted or duplicate sessions

If a previous `kimi_delegate_and_wait` was interrupted (for example, by pressing Esc), or if you are unsure whether a task is already running, call `kimi_recent_sessions` first. Check the returned `status`, `title`, and `webUrl` to decide whether to continue an existing session (`kimi_continue_task`), wait for it (`kimi_wait_until_idle`), or abort it (`kimi_abort`). Do not blindly start a new `kimi_delegate_task` before confirming there is no orphaned or duplicate session.

## Verification Commands

Run these before accepting implementation:

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

For plugin installation smoke checks:

```bash
codex plugin list | rg 'kimi-delegate|codex-kimi-bridge-local'
```

Expected status:

```text
kimi-delegate@codex-kimi-bridge-local  installed, enabled  0.1.0
```

## Completed MVP Capabilities

- Codex local plugin install works.
- MCP tools are exposed by Codex.
- Kimi server auth is handled via server token.
- Kimi server preflight and auto-start work.
- Successful preflight checks are short-cached by `KIMI_PREFLIGHT_CACHE_MS`.
- `kimi_bridge_status` reports `webBaseUrl`, `canOpenWeb`, `status`, `nextActions`, and diagnostics without leaking token values.
- `kimi_delegate_and_wait` returns an embedded `reviewPackage` on idle results.
- `kimi_review_package` can re-fetch review material for an existing session before commit.
- Delegate/continue responses include Kimi Web session URLs.
- Handoff expands untracked directories into concrete file paths when possible.
- End-to-end smoke test passed: Codex delegated a file creation to Kimi, read handoff/diff, reviewed the result, then delegated cleanup.

## Good Next Tasks

Prefer testing this bridge with a real small feature before adding more abstractions. If optimizing further, useful candidates are:

- Add a higher-level Codex prompt template for spec/plan/delegate/review loops.
- Improve status output if real usage reveals confusing diagnostics.
- Add more integration tests around real Kimi server API shape when safe.
- Consider packaging the plugin more portably instead of using an absolute `dist/index.js` path.

## Important Boundaries

- Do not change Kimi Code server unless explicitly requested.
- Do not change Codex plugin installation mechanics unless the task is specifically about plugin packaging.
- Do not use `--dangerous-bypass-auth` as a default. It is only for local smoke testing.
- Do not leak or commit token values.
- Do not revert user or Kimi changes unless the user explicitly asks.
