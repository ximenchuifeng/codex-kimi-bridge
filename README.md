# Codex Kimi Bridge

Local Codex plugin and MCP bridge for delegating implementation tasks to Kimi Code while Codex remains the planner and reviewer.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

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
- `tokenSource`, `autoStart`, `kimiCommand`, `preflightCacheMs`, `cacheFresh`, `cacheAgeMs`, `cachedUntil`: configuration and cache metadata.

`kimi_bridge_status` is safe to call at any time: it does not trigger auto-start, refresh the token, or modify the success cache.

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
- `status`: filter by session status such as `idle`, `running`, `awaiting_approval`, `awaiting_question`, or `aborted`.
- `includeArchive`: include archived sessions.
- `excludeEmpty`: exclude sessions with no messages.

The response contains an `items` array. Each item includes:

- `sessionId`, `status`, `title`, and `webUrl`
- `createdAt` and `updatedAt` when the server provides them

No token or authorization information is returned.

If you suspect a duplicate or still-running session, call `kimi_find_recent_session` or `kimi_recent_sessions` first and check the `status` and `webUrl` instead of blindly starting another `kimi_delegate_task`.

### Find a recent session by title

Use `kimi_find_recent_session` when you want to recover a session after an interruption (for example, pressing Esc), quota recovery, or when you suspect a duplicate task. It searches recent Kimi sessions by a substring of the session title.

Input fields:

- `titleContains` *(required)*: substring to search for in session titles. Case-insensitive. Leading/trailing whitespace is trimmed; an empty or whitespace-only value returns a clear error.
- `status`: filter by session status such as `idle`, `running`, `awaiting_approval`, `awaiting_question`, or `aborted`.
- `pageSize`: number of recent sessions to inspect. Default: `20`.
- `includeArchive`: include archived sessions.
- `excludeEmpty`: exclude sessions with no messages.

The response contains:

- `query`: the normalized query that was executed.
- `match`: the first matching session, if any.
- `candidates`: all matching sessions, in the order returned by the Kimi server.
- `suggestedNextActions`: guidance based on the matched session status, or suggestions to widen the keyword or call `kimi_recent_sessions` when nothing matches.

Status-based guidance:

- `running`: wait with `kimi_wait_until_idle` or open the `webUrl`.
- `idle`: call `kimi_review_package` or open the `webUrl`.
- `aborted`: open the `webUrl` to inspect the reason, then use `kimi_continue_task` if needed.
- `awaiting_approval` / `awaiting_question`: resolve the approval or question in Kimi Web, then continue waiting.

No token or authorization information is returned.

### One-call delegate and wait

Use `kimi_delegate_and_wait` when you want the bridge to perform the mechanical delegate/wait/handoff sequence in one MCP call. Codex still reviews the returned handoff and decides whether to accept the work or continue the session.

The result includes:

- `sessionId`, `promptId`, `submitStatus`, and `webUrl`
- `wait`, including `idle`, `timeout`, `awaiting_approval`, or `awaiting_question`
- `handoff` and `changedFiles` only when `wait.status` is `idle`
- `reviewPackage` only when `wait.status` is `idle`, with the same structure as `kimi_review_package`
- `diagnostics` only when `wait.status` is `timeout` or `aborted`

When `wait.status` is `idle`, the returned `reviewPackage` is ready for Codex review immediately. It contains `sessionId`, `webUrl`, `handoff`, `changedFiles`, `diffStats`, and `reviewChecklist`, and it shares the same `handoff` object as the top-level `handoff` field. Codex should prefer using this embedded review package for the first review so that diff content is not lost before a separate `kimi_review_package` call.

If the result is `timeout`, `diagnostics` contains:

- `recentMessages`: up to 3 recent messages with role and content (content truncated to 1000 characters)
- `lastAssistantMessage`: the content of the most recent assistant message, or an empty string
- `suggestedNextActions`: guidance to call `kimi_wait_until_idle` or open `webUrl` in the browser

If the result is `aborted`, `diagnostics` contains the same fields, with `suggestedNextActions` recommending opening `webUrl` to inspect the abort reason and using `kimi_continue_task` to retry or add instructions.

If the server cannot fetch messages for diagnostics, `recentMessages` is empty, `messagesUnavailable` is `true`, and `messageError` contains a safe error message with no token values. `suggestedNextActions` is still returned.

If the result is `timeout`, keep the `sessionId` and call `kimi_wait_until_idle` or `kimi_get_handoff` later. If it is blocked, resolve the approval/question in Kimi and continue the same session. Non-`idle` results do not include `handoff` or `reviewPackage`.

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
- `reviewChecklist`: a list of reminders for Codex, such as checking scope, tests, unrelated changes, and whether to call `kimi_continue_task`.

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
