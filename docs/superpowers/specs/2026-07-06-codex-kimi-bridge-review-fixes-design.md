# Codex Kimi Bridge Review Fixes Design

Date: 2026-07-06

## Goal

Fix the issues found in Codex review so the bridge becomes usable as a Codex plugin against a real Kimi server.

This is a corrective pass over the existing implementation, not a rewrite.

## Review Findings To Address

1. The Codex plugin manifest is invalid and fails local plugin validation.
2. The default plugin configuration has no model, so `kimi_delegate_task` fails unless every call passes `model`.
3. `kimi_abort` calls `/sessions/{id}/abort`, but Kimi server expects `/sessions/{id}:abort`.
4. `kimi_wait_until_idle` only returns `{ status }`, so Codex cannot see pending approval/question details when Kimi blocks.

## Non-Goals

- Do not implement a full WebSocket client in this fix pass.
- Do not implement ACP.
- Do not change the Codex/Kimi responsibility split.
- Do not make Codex auto-approve destructive actions.
- Do not rewrite the MCP tool surface unless needed for compatibility.

## Desired Behavior

### Valid Plugin Manifest

`plugins/kimi-delegate/.codex-plugin/plugin.json` must pass:

```bash
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected manifest shape:

- top-level `skills` should be a string path: `"./skills/"`
- top-level `mcpServers` should point to `"./.mcp.json"`
- include required `author`
- include required `interface`
- remove unsupported `mcp`

### Model Resolution

Delegation should work without requiring every MCP call to pass `model`.

Resolution order:

1. MCP tool input `model`
2. `KIMI_MODEL` env var
3. Kimi server config `default_model`

If all three are unavailable, return a structured MCP error explaining how to set `KIMI_MODEL`.

The bridge should read Kimi server config through the existing REST endpoint if available. Kimi Web already has config APIs, so this should use `/api/v1/config` or the real route used by `apps/kimi-web/src/api/daemon/client.ts`.

### Correct Abort Endpoint

`KimiClient.abortSession('s1')` must call:

```text
POST /api/v1/sessions/s1:abort
```

not:

```text
POST /api/v1/sessions/s1/abort
```

Tests and fake server must reflect the real Kimi route.

### Blocked Status Details

When `kimi_wait_until_idle` sees:

- `awaiting_approval`
- `awaiting_question`

it should return a structured result that includes the pending approvals/questions available from Kimi REST.

Minimum result shape:

```ts
type WaitResult =
  | { status: 'idle' | 'aborted' | 'timeout' }
  | { status: 'awaiting_approval'; approvals: PendingApproval[] }
  | { status: 'awaiting_question'; questions: PendingQuestion[] };
```

Add Kimi client methods:

- `listPendingApprovals(sessionId)`
- `listPendingQuestions(sessionId)`

Use Kimi routes:

- `GET /sessions/{sid}/approvals?status=pending`
- `GET /sessions/{sid}/questions?status=pending`

The bridge does not need to answer approvals/questions in this pass, only surface enough detail for Codex and the user to decide the next step.

## Testing Requirements

All existing tests must continue to pass.

Add or update tests for:

- plugin manifest validation command passes
- default model resolves from server config when `KIMI_MODEL` is unset
- missing model produces a structured MCP error
- abort uses `/sessions/{id}:abort`
- wait result includes pending approvals
- wait result includes pending questions

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

## Success Criteria

The fix is complete when:

- plugin validation passes
- `pnpm test`, `pnpm typecheck`, and `pnpm build` pass
- a default plugin install can call `kimi_delegate_task` without passing a model if Kimi server exposes `default_model`
- `kimi_abort` hits the real Kimi abort route
- blocked wait results expose pending approval/question details

