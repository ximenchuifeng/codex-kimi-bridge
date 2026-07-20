# Codex Kimi Bridge

Local Codex plugin and MCP bridge for delegating implementation tasks to Kimi Code while Codex remains the planner and reviewer.

## Prerequisites

- Git
- Node.js 20 or newer
- Codex with plugin support
- [Kimi Code](https://github.com/MoonshotAI/kimi-code), available as the `kimi` command

The plugin includes a tracked MCP server bundle. First-time installation does not require pnpm, dependency installation, or a TypeScript build.

## Install From Git

```bash
git clone https://github.com/ximenchuifeng/codex-kimi-bridge.git
cd codex-kimi-bridge
codex plugin marketplace add "$PWD"
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Open a new Codex task after installation so Codex loads the plugin tools. Confirm installation with:

```bash
codex plugin list | rg 'kimi-delegate|codex-kimi-bridge-local'
```

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

`pnpm build` compiles `dist/` for development and regenerates the tracked `plugins/kimi-delegate/mcp/server.mjs`. Commit the bundle whenever source changes affect the MCP runtime.

### Reinstall A Development Build

```bash
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/kimi-delegate
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Open a new Codex task after reinstalling. The helper adds a local `+codex.<timestamp>` cachebuster; release commits keep the plugin version as plain semantic version `0.3.0`. Do not hand-edit `.agents/plugins/marketplace.json` to refresh an installed plugin.

Upgrading a cloned checkout only requires pulling the desired release and reinstalling the same plugin. You do not need to re-add an already configured marketplace.

## Recommended Seamless Usage

You do not need to manually start Kimi server or copy tokens. The bridge can preflight and auto-start Kimi for you.

### Option 1: Persistent Kimi server (recommended for daily use)

Install and start Kimi as a persistent service:

```bash
kimi server install
kimi server start
```

Then use the Codex plugin normally. The bridge will discover the running server and authenticate using the token in your Kimi home.

### Option 2: Let the bridge auto-start Kimi

Keep the default `KIMI_AUTO_START=true` in the plugin env. The bridge will run:

```bash
kimi server run --keep-alive
```

when it first needs to call the Kimi server and no server is responding on `KIMI_SERVER_URL`.

### Token handling

The bridge reads the Kimi server token automatically. You do not need to copy it into the plugin config:

1. `KIMI_SERVER_TOKEN` if set and non-empty
2. `$KIMI_CODE_HOME/server.token` if `KIMI_CODE_HOME` is set
3. `~/.kimi-code/server.token` otherwise

If you use a custom `KIMI_CODE_HOME` for Kimi Code, make sure the bridge sees the same value:

```bash
# In the plugin env or your shell
export KIMI_CODE_HOME=/path/to/your/kimi/home
```

### Local baseline state

The bridge persists per-session Git baselines locally so that handoffs can report committed changes even when the Kimi server does not preserve arbitrary session metadata. Baselines are stored as one JSON file per session under:

```text
$KIMI_BRIDGE_STATE_DIR/<server-identity>/<session-id>.json
```

- Default: `~/.codex-kimi-bridge/state`
- Override: `KIMI_BRIDGE_STATE_DIR=/path/to/state`
- Each file contains only the baseline commit, branch, initial dirty paths, and delegation-time worktree snapshot. No token or credential is stored.
- Files are written atomically (`write` to a temp file, then `rename`) and validated when read.
- If writing a baseline fails, delegation still proceeds and the result reports `baselineStored: false` with a safe `baselineStoreError`.

### Preflight cache

The bridge preflights the Kimi server before each tool call. A successful preflight result is cached for a short time so that a rapid sequence of calls does not repeat healthz + config checks.

- `KIMI_PREFLIGHT_CACHE_MS` controls the cache lifetime in milliseconds.
- Default: `5000` (5 seconds).
- Set to `0` to disable caching and check every time.
- Malformed or negative values fall back to `5000`.

The `kimi_bridge_status` tool always performs a live check and does not use or update the success cache, so it reflects the current server state. It returns a read-only diagnostic object with the following fields:

- `serverUrl`: the normalized Kimi server base URL.
- `webBaseUrl`: `<serverUrl>/`, a safe URL you can open in a browser. It never includes a token.
- `canOpenWeb`: `true` when `healthzOk` is `true`.
- `healthzOk`: whether the server `/healthz` endpoint responded.
- `authOk`: whether the server `/config` endpoint accepted the resolved token.
- `status`: one of `ready`, `server_unreachable`, or `auth_failed`.
- `nextActions`: human-readable suggestions for what to do next. The messages are localized to Chinese and guide you based on the current state:
  - `ready`: indicates you can keep delegating tasks and open `webBaseUrl` or a task's `webUrl` to view the session.
  - `server_unreachable` with `autoStart=true`: the next task call will try to auto-start the server, or you can run `kimi server run --keep-alive` manually.
  - `server_unreachable` with `autoStart=false`: start the server manually or set `KIMI_AUTO_START=true`.
  - `auth_failed`: check `KIMI_SERVER_TOKEN` / `KIMI_CODE_HOME`, or for local smoke testing start Kimi with `--dangerous-bypass-auth`.
- `commands` *(optional)*: an array of safe, copyable shell commands that you can run to act on the diagnosis. Any dynamic values taken from configuration (such as `kimiCommand` or `kimiCodeHome`) are shell-quoted so the commands remain valid even when those values contain spaces or quotes. Token values are never included. The array is empty or omitted in the `ready` state. For other states it may include commands such as:
  - `server_unreachable` + `autoStart=false`: `kimi server start`
  - `server_unreachable` + `autoStart=true`: `kimi server run --keep-alive`
  - `auth_failed`: a safe check such as `test -f ~/.kimi-code/server.token && echo "token file exists" || echo "token file missing"`, or a hint when the token comes from `KIMI_SERVER_TOKEN`
  - if the bridge/plugin was just changed: `pnpm build` and `codex plugin add kimi-delegate@codex-kimi-bridge-local`
- `diagnostics`: technical messages from the latest live checks. Token values are never included.
- `serverVersion` *(optional)*: the Kimi server version from `/api/v1/meta`, when available.
- `backend` *(optional)*: the Kimi server backend from `/api/v1/meta`, when available.
- `tokenSource`, `autoStart`, `kimiCommand`, `preflightCacheMs`, `cacheFresh`, `cacheAgeMs`, `cachedUntil`: configuration and cache metadata.

`kimi_bridge_status` is safe to call at any time: it does not trigger auto-start, refresh the token, or modify the success cache.

The bridge accepts both legacy Kimi Session `status` responses and Kimi 0.27+ `busy` / `pending_interaction` / `last_turn_reason` responses. All lifecycle decisions use one normalized runtime status.

`failed` is a terminal Bridge status. A failed delegate does not produce a successful `reviewPackage`; open `webUrl`, inspect the failure, and use `kimi_continue_task` to continue the same session when recovery is appropriate. `failed` and `aborted` sessions are never automatically reused by dedupe.

`kimi_bridge_status` may include `serverVersion` and `backend` from `/api/v1/meta`. These fields are diagnostic only and never select the compatibility path.

### Local smoke test with auth disabled

For local smoke testing only, you can start Kimi with authentication disabled:

```bash
kimi server run --foreground --dangerous-bypass-auth
```

## Smoke test

Build the bridge and verify it starts against a running Kimi server:

```bash
pnpm build
export KIMI_SERVER_URL=http://127.0.0.1:58627
export KIMI_PERMISSION_MODE=auto
export KIMI_THINKING=high
# Starts the MCP server on stdio. In another terminal you can send JSON-RPC messages.
node dist/index.js
```

Or run a quick one-shot health check if the Kimi server exposes `/api/v1/healthz`:

```bash
curl "$KIMI_SERVER_URL/api/v1/healthz"
```

## Kimi Server

Start Kimi server before using the bridge (or let the bridge auto-start it):

```bash
kimi server run --foreground
```

Default bridge target:

```text
http://127.0.0.1:58627
```

## Authentication

The Kimi server REST API requires a Bearer token by default. The bridge resolves the token in this order:

1. `KIMI_SERVER_TOKEN` environment variable
2. `$KIMI_CODE_HOME/server.token` if `KIMI_CODE_HOME` is set
3. `~/.kimi-code/server.token` if it exists and is non-empty

Set the token explicitly if you prefer:

```bash
export KIMI_SERVER_TOKEN="your-kimi-server-token"
```

Or write it to the default token file:

```bash
mkdir -p ~/.kimi-code
echo -n "your-kimi-server-token" > ~/.kimi-code/server.token
```

## Web session links

Both `kimi_delegate_task`, `kimi_continue_task`, and `kimi_review_package` return a `webUrl` pointing to the Kimi Web view of the session:

```text
<serverUrl>/sessions/<sessionId>
```

The `sessionId` is URL-encoded, and the link intentionally contains no server token or authentication query parameters. If you have already opened and authenticated with Kimi Web in your browser, you can visit `webUrl` directly. If you have not yet authenticated, the Kimi Web UI will prompt you to authenticate before showing the session.

### Recent sessions

Use `kimi_recent_sessions` to inspect recent Kimi sessions before delegating more work. This helps avoid orphaned or duplicate sessions when a previous `kimi_delegate_and_wait` was interrupted (for example, by pressing Esc) or when you are unsure whether a task is still running.

Input fields (all optional):

- `pageSize`: number of sessions to return. Default: `10`.
- `status`: filter by session status such as `idle`, `running`, `awaiting_approval`, `awaiting_question`, `aborted`, or `failed`.
- `includeArchive`: include archived sessions.
- `excludeEmpty`: exclude sessions with no messages.

The response contains an `items` array. Each item includes:

- `sessionId`, `status`, `title`, and `webUrl`
- `cwd`: the session's original working directory, taken from `session.metadata.cwd`. Included for diagnostics only; the `webUrl` is not affected.
- `createdAt` and `updatedAt` when the server provides them

No token or authorization information is returned.

If you suspect a duplicate or still-running session, call `kimi_find_recent_session` or `kimi_recent_sessions` first and check the `status` and `webUrl` instead of blindly starting another `kimi_delegate_task`.

### Find a recent session by title

Use `kimi_find_recent_session` when you want to recover a session after an interruption (for example, pressing Esc), quota recovery, or when you suspect a duplicate task. It searches recent Kimi sessions by a substring of the session title.

Input fields:

- `titleContains` *(required)*: substring to search for in session titles. Case-insensitive. Leading/trailing whitespace is trimmed; an empty or whitespace-only value returns a clear error.
- `status`: filter by session status such as `idle`, `running`, `awaiting_approval`, `awaiting_question`, `aborted`, or `failed`.
- `pageSize`: number of recent sessions to inspect. Default: `20`.
- `includeArchive`: include archived sessions.
- `excludeEmpty`: exclude sessions with no messages.
- `cwd` *(optional)*: when provided, only sessions whose `metadata.cwd` matches this directory are returned. Trailing-slash differences are normalized, so `/repo` and `/repo/` are treated as the same directory.
- `matchAnyCwd` *(optional)*: when `true`, disables the `cwd` filter and returns title matches from any working directory. Default: `false`.
- `includeSummary` *(optional)*: when `true`, fetches the last user/assistant message and message count for each returned candidate. Default: `false`. Keep `false` for normal lookups to avoid the extra latency; enable it when recovering from an interruption or deciding whether to reuse a session. The summary skips internal reminder messages (for example, `<system-reminder>` and `<plugin_session_start>`) so that `lastUserMessage` and `lastAssistantMessage` reflect the real task context.

The response contains:

- `query`: the normalized query that was executed.
- `match`: the first matching session, if any.
- `candidates`: all matching sessions, in the order returned by the Kimi server. If `cwd` is provided and `matchAnyCwd` is not `true`, this list only includes sessions from the same `cwd`.
- `skippedCandidates` *(optional)*: sessions whose title matched but whose `cwd` did not match. Only present when `cwd` is provided, `matchAnyCwd` is not `true`, and at least one title match was excluded for this reason.
- `suggestedNextActions`: guidance based on the matched session status, or suggestions to widen the keyword or call `kimi_recent_sessions` when nothing matches.

When `includeSummary` is `true`, each session in `candidates`, `match`, and `skippedCandidates` may include a `summary` with:

- `messageCount`: total number of messages in the session. Internal reminder messages are skipped when picking `lastUserMessage` and `lastAssistantMessage`, so those fields reflect the real task context.
- `lastUserMessage`: content of the most recent non-internal `user` message, truncated to 1000 characters and redacted for tokens. Omitted when there is no non-internal user message.
- `lastAssistantMessage`: content of the most recent non-internal `assistant` message, truncated to 1000 characters and redacted for tokens. Omitted when there is no non-internal assistant message.
- `messagesUnavailable`: `true` when message fetching failed.
- `messageError`: a safe error message when message fetching failed.

Status-based guidance:

- `running`: wait with `kimi_wait_until_idle` or open the `webUrl`.
- `idle`: call `kimi_review_package` or open the `webUrl`.
- `aborted`: open the `webUrl` to inspect the reason, then use `kimi_continue_task` if needed.
- `failed`: open the `webUrl` to inspect the failure, then use `kimi_continue_task` after fixing the cause.
- `awaiting_approval` / `awaiting_question`: resolve the approval or question in Kimi Web, then continue waiting.

No token or authorization information is returned.

### One-call delegate and wait

Use `kimi_delegate_and_wait` when you want the bridge to perform the mechanical delegate/wait/handoff sequence in one MCP call. Codex still reviews the returned handoff and decides whether to accept the work or continue the session.

The result includes:

- `sessionId`, `promptId`, `submitStatus`, and `webUrl`
- `wait`, including `idle`, `timeout`, `awaiting_approval`, `awaiting_question`, `aborted`, or `failed`
- `handoff` and `changedFiles` only when `wait.status` is `idle`
- `reviewPackage` only when `wait.status` is `idle`, with the same structure as `kimi_review_package`
- `diagnostics` only when `wait.status` is `timeout`, `aborted`, or `failed`

When `wait.status` is `idle`, the returned `reviewPackage` is ready for Codex review immediately. It contains `sessionId`, `webUrl`, `handoff`, `changedFiles`, `diffStats`, and `reviewChecklist`, and it shares the same `handoff` object as the top-level `handoff` field. Codex should prefer using this embedded review package for the first review so that diff content is not lost before a separate `kimi_review_package` call.

If the result is `timeout`, `diagnostics` contains:

- `recentMessages`: up to 3 recent messages with role and content (content truncated to 1000 characters)
- `lastAssistantMessage`: the content of the most recent assistant message, or an empty string
- `suggestedNextActions`: guidance to call `kimi_wait_until_idle` or open `webUrl` in the browser

If the result is `aborted` or `failed`, `diagnostics` contains the same fields, with `suggestedNextActions` recommending opening `webUrl` to inspect the reason and using `kimi_continue_task` to retry or add instructions.

If the server cannot fetch messages for diagnostics, `recentMessages` is empty, `messagesUnavailable` is `true`, and `messageError` contains a safe error message with no token values. `suggestedNextActions` is still returned.

If the result is `timeout`, keep the `sessionId` and call `kimi_wait_until_idle` or `kimi_get_handoff` later. If it is `failed`, fix the cause before continuing the same session with `kimi_continue_task`. If it is blocked, resolve the approval/question in Kimi and continue the same session. Non-`idle` results do not include `handoff` or `reviewPackage`.

#### Dedupe guard

`kimi_delegate_and_wait` accepts an optional `dedupe` object that prevents accidentally creating a duplicate Kimi session after an interruption (for example, pressing Esc), quota recovery, or a mis-click. When `dedupe` is provided, the bridge first searches recent sessions by title substring using the same semantics as `kimi_find_recent_session`. If a reusable session is found, it returns the existing session instead of creating a new one.

Input fields under `dedupe`:

- `titleContains` *(required)*: substring to search for in session titles. Case-insensitive. Leading/trailing whitespace is trimmed; an empty or whitespace-only value returns a clear error.
- `status`: filter by session status such as `idle`, `running`, `awaiting_approval`, `awaiting_question`, `aborted`, or `failed`.
- `pageSize`: number of recent sessions to inspect. Default: `20`.
- `includeArchive`: include archived sessions.
- `excludeEmpty`: exclude sessions with no messages.
- `reuseIfStatus`: array of statuses that the caller considers reusable. Default: `["running", "idle", "awaiting_approval", "awaiting_question"]`.
- `matchAnyCwd` *(optional)*: when `true`, allows reusing a session from any working directory. Default: `false`.
- `includeSummary` *(optional)*: when `true`, fetches the last user/assistant message and message count for the matched session and any `skippedCandidates`. Default: `false`. Enable it when recovering from an interruption or deciding whether to reuse an old session; keep it `false` for normal calls to avoid extra latency. The summary skips internal reminder messages (for example, `<system-reminder>` and `<plugin_session_start>`) so that `lastUserMessage` and `lastAssistantMessage` reflect the real task context.

By default, dedupe only reuses a session if its `metadata.cwd` matches the `cwd` passed to `kimi_delegate_and_wait`. This prevents accidentally reusing a session from a different project or workspace, even when the title matches. Trailing-slash differences are normalized, so `/repo` and `/repo/` are treated as the same directory. Only set `matchAnyCwd: true` when you intentionally want to recover a session from another workspace.

Only the following statuses can actually be reused automatically: `running`, `idle`, `awaiting_approval`, and `awaiting_question`. The bridge will never automatically reuse an `aborted` or `failed` session, even if you include it in `reuseIfStatus`. If you find an aborted or failed session, inspect the `webUrl` and use `kimi_continue_task` instead of relying on `kimi_delegate_and_wait` to resume it.

Result behavior:

- If `dedupe` is omitted, the tool behaves exactly as before and creates a new session.
- If no matching session is found, the tool delegates normally and includes `dedupe.checked=true`, `dedupe.matched=false`, `dedupe.reused=false` in the result.
- If a matching session is `running`, `idle`, `awaiting_approval`, or `awaiting_question`, and that status is in `reuseIfStatus`, and the session `cwd` matches (or `matchAnyCwd` is `true`), the result contains the existing `sessionId`, `webUrl`, and appropriate wait state. No new session is created and no prompt is submitted. `dedupe.reused` is `true` and `dedupe.cwdMatched` indicates whether the reuse happened within the same `cwd`.
- If a matching session is supported for reuse but its status is not in `reuseIfStatus`, the tool delegates normally and reports `dedupe.matched=true`, `dedupe.reused=false`, `dedupe.reason="status_not_reusable"`.
- If a matching session is not supported for reuse at all (for example, `aborted` or `failed`), the tool delegates normally and reports `dedupe.matched=true`, `dedupe.reused=false`, `dedupe.reason="status_not_supported"`. For `aborted` or `failed` matches, open the `webUrl` to inspect the cause and use `kimi_continue_task` if needed.
- If one or more title matches were found but all were excluded because their `cwd` differed, the tool delegates normally and reports `dedupe.matched=false`, `dedupe.reused=false`, `dedupe.reason="cwd_mismatch"`, plus `dedupe.skippedCandidates` for diagnostics.

No token or authorization information is returned by the dedupe search.

### Review package for Codex review

`kimi_review_package` prepares a structured review package for Codex. It takes a `sessionId` and returns:

- `sessionId` and `webUrl`: the same session link returned by other tools.
- `handoff`: the full handoff from `kimi_get_handoff`, including `finalMessage`, `changedFiles`, `additions`, `deletions`, and `diffs`.
- `changedFiles`: alias of `handoff.changedFiles`.
- `diffStats`: summary counts:
  - `filesChanged`
  - `additions`
  - `deletions`
  - `diffsWithContent`: number of diffs whose `diff` string is non-empty.
  - `committed`: per-source stats for changes already committed by Kimi from the delegation baseline to current `HEAD`.
  - `workingTree`: per-source stats for current staged/unstaged/untracked changes.
- `reviewChecklist`: a list of reminders for Codex, such as checking scope, tests, unrelated changes, and whether to call `kimi_continue_task`.

The `handoff` now separates committed and working-tree evidence:

- `baseCommit`: the Git baseline captured when the session was created.
- `headCommit`: the current `HEAD` commit when the handoff was generated.
- `reviewWorkspace`: the absolute path of the Git worktree whose `HEAD` advanced from `baseCommit` and was used to produce `committedChanges`. When Kimi committed in a nested worktree (for example, a Superpowers-style `.worktrees/...` checkout), this field tells Codex exactly where the commit evidence came from.
- `commits`: commit summaries between `baseCommit` and `headCommit`.
- `initialDirtyPaths`: paths that were already dirty at delegation time (diagnostic only; not subtracted from later working-tree changes).
- `committedChanges`: changes already committed by Kimi (`available: false` with `unavailableReason` for legacy sessions, invalid ancestry, or ambiguous worktrees).
- `workingTreeChanges`: current working-tree/staging changes. If `reviewWorkspace` differs from the session `cwd`, this section is marked `available: false` with `unavailableReason: 'review_workspace_mismatch'` rather than presenting a clean working tree from the wrong checkout.
- `changedFiles`, `additions`, `deletions`, and `diffs` remain as aggregate compatibility fields across both sources.

Important review semantics:

- A clean working tree does **not** prove Kimi made no changes; inspect `committedChanges`.
- `workingTreeChanges` may include pre-existing user work listed in `initialDirtyPaths`.
- `available: false` means the committed evidence is unavailable, not that there are zero committed changes. Use `unavailableReason` and direct `git log`/`git diff` when necessary.
- The bridge loads the baseline from its local store first and falls back to session metadata only for backward compatibility. Real Kimi 0.27 servers strip extra metadata, so production handoffs depend on the durable local store.
- `reviewWorkspace` selection uses the delegation-time worktree snapshot. Pre-existing worktrees that already differed from `baseCommit` are ignored, newly created or advanced worktrees are selected, and multiple equally plausible candidates return `ambiguous_worktrees` with candidate diagnostics.
- Old sessions created before this feature lack a baseline and return `baseline_unavailable` for `committedChanges`.

Use this tool to normalize the review step instead of manually reading `handoff` and `diffs`. When `kimi_delegate_and_wait` already returned `idle` with an embedded `reviewPackage`, you can review that package directly; call `kimi_review_package` afterward only if you need to re-fetch the latest handoff for the same session.

## Model Resolution

The bridge resolves the Kimi model in this order:

1. `model` passed to the MCP tool call
2. `KIMI_MODEL` environment variable
3. Kimi server `default_model` from `/api/v1/config`

If none are available, the MCP tool returns a structured error. For predictable local use, set:

```bash
export KIMI_MODEL=<your-kimi-model>
```

## Troubleshooting

### Plugin MCP Server Does Not Start

- Confirm `node --version` reports Node.js 20 or newer.
- Confirm `plugins/kimi-delegate/mcp/server.mjs` exists in the checkout.
- For a source checkout modified locally, run `pnpm install && pnpm build`, then reinstall the plugin with the cachebuster flow.
- After reinstalling, open a new Codex task so its MCP tool list refreshes.

## Collaboration Model

Codex:

- writes spec and plan
- delegates implementation to Kimi
- reviews diffs and tests
- sends follow-up feedback

Kimi:

- implements the task
- may use AgentSwarm internally
- returns a structured handoff
