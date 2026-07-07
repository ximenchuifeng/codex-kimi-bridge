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
