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
node ./mcp/server.mjs
```

After code changes that affect MCP tools or plugin config, run:

```bash
pnpm build
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Then open a new Codex thread or restart Codex if the tool list does not refresh.

- `plugins/kimi-delegate/mcp/server.mjs` is a tracked generated artifact.
- Source changes affecting MCP runtime require `pnpm build` and committing the regenerated bundle.
- Fresh clone installation does not require pnpm because the bundle is tracked.
- Development reinstalls use `update_plugin_cachebuster.py`; release manifests use plain semantic versions.

## Kimi Server

Default server:

```text
http://127.0.0.1:58627
```

The bridge supports both legacy Kimi Session `status` responses and Kimi 0.27+ `busy` / `pending_interaction` / `last_turn_reason` responses. All lifecycle decisions normalize these into one Bridge runtime status. `kimi_bridge_status` may expose safe `serverVersion` and `backend` metadata from `/api/v1/meta`, but this metadata is diagnostic only and never selects the compatibility path.

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
- `kimi_find_recent_session`: find a recent Kimi session by title substring; preferred when recovering from an interruption, quota recovery, or suspected duplicate task.
- `kimi_delegate_task`: start a Kimi task from a Codex spec/plan.
- `kimi_delegate_and_wait`: preferred one-call flow; delegates, waits, and returns `reviewPackage` when idle. Supports an optional `dedupe` object to avoid duplicate sessions.
- `kimi_wait_until_idle`: wait for Kimi to finish or report approval/question blocking.
- `kimi_get_handoff`: summarize Kimi output, changed files, and diffs.
- `kimi_review_package`: re-fetch a structured review package for an existing session.
- `kimi_get_diff`: inspect a specific file diff.
- `kimi_continue_task`: send review feedback or follow-up work to an existing Kimi session.
- `kimi_abort`: abort a Kimi session.

Delegate and review tools return `webUrl`, which can be opened in Kimi Web to watch the session.

## Reviewing handoffs

`kimi_get_handoff`, `kimi_review_package`, and the embedded `reviewPackage` from `kimi_delegate_and_wait` expose both committed and working-tree evidence:

- `committedChanges`: changes already committed by Kimi from the delegation baseline to current `HEAD`.
- `workingTreeChanges`: current staged, unstaged, and untracked changes.
- `initialDirtyPaths`: paths that were already dirty when the session was created (diagnostic only).
- Top-level `changedFiles`, `additions`, `deletions`, and `diffs` aggregate both sources for compatibility.

Review rules:

- Do not infer "no changes" from a clean working tree alone. Inspect `committedChanges` for commits and file diffs.
- `workingTreeChanges` may include pre-existing user work; compare with `initialDirtyPaths`.
- `available: false` in `committedChanges` means evidence is unavailable, not that there are zero committed changes. Read `unavailableReason` and use direct `git log`/`git diff` when needed.
- Legacy sessions created before this feature lack a baseline and return `baseline_unavailable`.
- Review both change sets before acceptance and use `kimi_continue_task` for fixes.

## Handling interrupted or duplicate sessions

If a previous `kimi_delegate_and_wait` was interrupted (for example, by pressing Esc), or if you are unsure whether a task is already running, the recommended approach is to pass `dedupe` to `kimi_delegate_and_wait`:

```json
{
  "titleContains": "<a stable substring from the original task title>",
  "reuseIfStatus": ["running", "idle", "awaiting_approval", "awaiting_question"]
}
```

When recovering from an interruption or deciding whether to reuse an old session, set `includeSummary: true` on `kimi_find_recent_session` or on `kimi_delegate_and_wait.dedupe` to see the last user/assistant message and message count. Leave it `false` by default to avoid the extra message fetch.

`dedupe` only reuses sessions in `running`, `idle`, `awaiting_approval`, or `awaiting_question` status. It never automatically reuses an `aborted` or `failed` session. If the matched session is `aborted` or `failed`, inspect the `webUrl` and use `kimi_continue_task` to resume it manually; do not expect `kimi_delegate_and_wait` to resume it automatically.

By default, `dedupe` only reuses a session when its `metadata.cwd` matches the `cwd` passed to `kimi_delegate_and_wait`. This prevents accidentally reusing a session from a different project or workspace even when the title matches. Only pass `matchAnyCwd: true` when you intentionally want to recover a session from another workspace; for daily use, keep the default `cwd-safe` behavior.

If you need more control, or if the task title is hard to make unique, call `kimi_find_recent_session` (when you remember part of the title) or `kimi_recent_sessions` first. Check the returned `status`, `title`, and `webUrl` to decide whether to continue an existing session (`kimi_continue_task`), wait for it (`kimi_wait_until_idle`), or abort it (`kimi_abort`). Do not blindly start a new `kimi_delegate_task` before confirming there is no orphaned or duplicate session.

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
kimi-delegate@codex-kimi-bridge-local  installed, enabled  0.3.0
```

## Completed MVP Capabilities

- Codex local plugin install works.
- MCP tools are exposed by Codex.
- Kimi server auth is handled via server token.
- Kimi server preflight and auto-start work.
- Successful preflight checks are short-cached by `KIMI_PREFLIGHT_CACHE_MS`.
- `kimi_bridge_status` reports `webBaseUrl`, `canOpenWeb`, `status`, `nextActions`, and diagnostics without leaking token values, and may include safe `serverVersion`/`backend` metadata from `/api/v1/meta`.
- `kimi_delegate_and_wait` returns an embedded `reviewPackage` on idle results.
- `kimi_review_package` can re-fetch review material for an existing session before commit.
- Delegate/continue responses include Kimi Web session URLs.
- `kimi_recent_sessions` and `kimi_find_recent_session` can recover interrupted or duplicate sessions.
- `kimi_delegate_and_wait.dedupe` prevents duplicate sessions, defaults to cwd-safe matching, and can include cleaned session summaries for recovery decisions.
- Session summaries skip internal reminder/control messages and redact token-like values.
- Handoff expands untracked directories into concrete file paths when possible.
- Bridge runtime status normalizes both legacy `status` responses and Kimi 0.27+ `busy`/`pending_interaction`/`last_turn_reason` responses.
- `failed` is an explicit terminal status: it receives no success `reviewPackage` and is not automatically reused by dedupe.
- End-to-end smoke test passed: Codex delegated a file creation to Kimi, read handoff/diff, reviewed the result, then delegated cleanup.

## Good Next Tasks

Prefer using this bridge on a real external repo/task before adding more abstractions. If optimizing further, useful candidates are:

- Improve status output if real usage reveals confusing diagnostics.
- Add more integration tests around real Kimi server API shape when safe.

## Important Boundaries

- Do not change Kimi Code server unless explicitly requested.
- Do not change Codex plugin installation mechanics unless the task is specifically about plugin packaging.
- Do not use `--dangerous-bypass-auth` as a default. It is only for local smoke testing.
- Do not leak or commit token values.
- Do not revert user or Kimi changes unless the user explicitly asks.
