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

Both `kimi_delegate_task` and `kimi_continue_task` return a `webUrl` pointing to the Kimi Web view of the session:

```text
<serverUrl>/sessions/<sessionId>
```

The `sessionId` is URL-encoded, and the link intentionally contains no server token or authentication query parameters. If you have already opened and authenticated with Kimi Web in your browser, you can visit `webUrl` directly. If you have not yet authenticated, the Kimi Web UI will prompt you to authenticate before showing the session.

### One-call delegate and wait

Use `kimi_delegate_and_wait` when you want the bridge to perform the mechanical delegate/wait/handoff sequence in one MCP call. Codex still reviews the returned handoff and decides whether to accept the work or continue the session.

The result includes:

- `sessionId`, `promptId`, `submitStatus`, and `webUrl`
- `wait`, including `idle`, `timeout`, `awaiting_approval`, or `awaiting_question`
- `handoff` and `changedFiles` only when `wait.status` is `idle`

If the result is `timeout`, keep the `sessionId` and call `kimi_wait_until_idle` or `kimi_get_handoff` later. If it is blocked, resolve the approval/question in Kimi and continue the same session.

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
