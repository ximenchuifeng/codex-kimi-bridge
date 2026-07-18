# Kimi 0.27 Runtime Status Compatibility Design

## Summary

Kimi Code 0.27 changed the session state wire contract used by the local server. Older servers expose a synthetic `status` field on session and status responses. Kimi 0.27 exposes orthogonal state facts instead:

- Session resources expose `busy`, `pending_interaction`, and `last_turn_reason`.
- `GET /api/v1/sessions/{session_id}/status` exposes `busy` plus model and context information, but no `status` field.
- `GET /api/v1/sessions` accepts `busy` rather than the former `status` query parameter.

The bridge currently assumes that `status` always exists. This can cause wait, handoff, recent-session recovery, and dedupe behavior to receive `undefined` and treat it as a terminal result.

This change adds one structural compatibility layer that accepts both the legacy and Kimi 0.27 wire shapes and exposes one stable Bridge runtime status model.

## Goals

- Support legacy Kimi session responses containing `status`.
- Support Kimi 0.27+ session responses containing `busy`, `pending_interaction`, and `last_turn_reason`.
- Ensure all Bridge tools consume one normalized runtime status.
- Add `failed` as an explicit terminal Bridge status.
- Preserve existing tool fields and behavior for the existing statuses.
- Make unknown or malformed state responses fail clearly instead of being mistaken for completed work.
- Cover the real Kimi 0.27 response shape in fixtures and tests.

## Non-Goals

- Migrating the bridge to `/api/v2` or `@moonshot-ai/klient`.
- Removing compatibility with older Kimi servers.
- Changing Kimi Code server implementation.
- Changing Codex plugin installation mechanics.
- Automatically answering approvals or questions.
- Adding WebSocket event-driven waiting in this iteration.
- Refactoring unrelated bridge modules.

## Public Runtime Status

The Bridge runtime status type becomes:

```ts
export type BridgeRuntimeStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted'
  | 'failed';
```

`failed` is additive. Existing status names and their meanings remain unchanged.

### Normalization Precedence

The normalizer uses the following precedence:

1. A recognized legacy `status` is returned unchanged.
2. `pending_interaction=approval` maps to `awaiting_approval`.
3. `pending_interaction=question` maps to `awaiting_question`.
4. `busy=true` maps to `running`.
5. `busy=false` with `last_turn_reason=cancelled` maps to `aborted`.
6. `busy=false` with `last_turn_reason=failed` maps to `failed`.
7. `busy=false` with `last_turn_reason=completed` maps to `idle`.
8. `busy=false` without `last_turn_reason` maps to `idle`, covering cold and empty sessions.
9. Any other shape throws a compatibility error that lists field names but does not serialize token-like values or the full response body.

The legacy field takes precedence so a server that temporarily exposes both representations preserves its declared legacy behavior.

## Wire Types And Adapter

Create `src/kimi/runtime-status.ts` as the only module responsible for mapping server state to Bridge state.

It exports:

```ts
export type BridgeRuntimeStatus =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'awaiting_question'
  | 'aborted'
  | 'failed';

export interface SessionStateFacts {
  status?: unknown;
  busy?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
}

export function normalizeRuntimeStatus(
  facts: SessionStateFacts,
): BridgeRuntimeStatus;
```

`src/kimi/types.ts` models the server resource as a compatibility wire type. `status`, `busy`, `pending_interaction`, and `last_turn_reason` are optional at the type boundary because different supported server versions expose different subsets. Bridge-facing result types use `BridgeRuntimeStatus`, not the optional wire fields.

## Client Behavior

`KimiClient` adds:

```ts
getRuntimeStatus(sessionId: string): Promise<BridgeRuntimeStatus>
```

It reads `GET /sessions/{session_id}` and normalizes that Session resource. The Session endpoint is the common source that contains enough state for both supported contracts:

- Legacy server: `status`.
- Kimi 0.27+: `busy`, `pending_interaction`, and `last_turn_reason`.

The existing `GET /sessions/{session_id}/status` client method may remain for model/context telemetry, but no Bridge lifecycle decision may depend on a `status` property from that response.

### Listing And Filtering

The bridge must not rely on the server accepting the legacy `status` query parameter.

When no Bridge status filter is requested, `listSessions` keeps the requested page size and returns normalized items.

When a Bridge status filter is requested:

- Request up to the server maximum of 100 recent sessions without a `status` query parameter.
- Normalize every returned item.
- Filter by the requested Bridge status in the client.
- Slice the filtered result to the caller's requested `pageSize`.

This produces the same Bridge behavior against old and new servers without branching on a version string. The current tool API has no cursor, so this bounded recent-window behavior is explicit and sufficient for dedupe and recovery.

## Tool Behavior

### `kimi_wait_until_idle`

- Poll `getRuntimeStatus`.
- Continue polling for `running`.
- Return immediately for `idle`, `awaiting_approval`, `awaiting_question`, `aborted`, or `failed`.
- Fetch pending approvals or questions only for the matching interaction status.

### `kimi_delegate_and_wait`

- Preserve the current successful `idle` behavior and embedded `reviewPackage`.
- Treat `failed` like `aborted` for completion packaging: return diagnostics and do not generate a success handoff or `reviewPackage`.
- Diagnostics recommend opening `webUrl`, inspecting the last messages, and continuing the same session when appropriate.

### `kimi_get_handoff` And `kimi_review_package`

- Normalize the already-fetched Session resource and use that value as `waitStatus`.
- Do not read `status.status` from the `/status` endpoint.
- Keep message, Git status, changed-file expansion, and diff behavior unchanged.

### Recent Session And Dedupe Tools

- `kimi_recent_sessions` and `kimi_find_recent_session` return normalized statuses.
- Status filtering is performed on normalized values.
- `failed` is displayed with guidance to inspect `webUrl` and use `kimi_continue_task` when recovery is appropriate.
- The default dedupe reusable set remains `running`, `idle`, `awaiting_approval`, and `awaiting_question`.
- `failed` and `aborted` are never automatically reused.
- Existing cwd-safe matching, summary filtering, and token redaction remain unchanged.

### `kimi_abort`

The abort route and response remain unchanged. A later observation of a Kimi 0.27 session whose `last_turn_reason` is `cancelled` normalizes to `aborted`.

## Metadata And Diagnostics

Add a client call for `GET /api/v1/meta` and expose safe server metadata in `kimi_bridge_status` diagnostics when available:

- `serverVersion`
- `backend`

Metadata is diagnostic only. Runtime behavior must be selected by response shape, not by hard-coded version comparisons. Failure to read `/meta` must not make an otherwise healthy bridge unavailable.

No token, authorization header, or token-bearing URL may appear in status output, errors, fixtures, documentation, or tests.

## Error Handling

- An unrecognized state response throws a dedicated compatibility error or a clear `Error` naming the endpoint and observed field names.
- Unknown state must never be interpreted as `idle`.
- A malformed list item must fail the list operation clearly rather than silently entering dedupe with an undefined status.
- `failed` results include the same safe recent-message diagnostics pattern used by `aborted` and `timeout`.
- Existing Kimi API, network, and authentication error handling remains unchanged.

## Testing Strategy

### Unit Tests

Add table-driven tests for `normalizeRuntimeStatus` covering:

- Every legacy status.
- Approval and question precedence over `busy`.
- Running, completed, cancelled, failed, and cold/empty Kimi 0.27 sessions.
- A hybrid response containing both representations.
- Unknown legacy values, invalid field types, and missing state fields.

### Client Tests

- Verify `getRuntimeStatus` normalizes legacy and Kimi 0.27 Session resources.
- Verify status-filtered listing omits the obsolete `status` query, requests a bounded recent window, filters normalized items, and applies the requested page size.
- Verify unfiltered listing preserves normal page-size behavior.

### Tool Tests

- Update wait, handoff, review, recent-session, find-session, and dedupe tests to use realistic Kimi 0.27 fixtures.
- Retain focused legacy fixtures to prove backward compatibility.
- Verify `failed` is terminal, includes diagnostics in `kimi_delegate_and_wait`, creates no success `reviewPackage`, and is not automatically reused by dedupe.
- Verify pending approval/question details are still fetched.

### Integration Fixtures

Update `test/fixtures/fake-kimi-server.ts` so its default Session and status responses match Kimi 0.27. Add explicit legacy variants where compatibility needs to be exercised.

Add a real-server contract smoke procedure that checks response field shapes without printing token values. It should validate:

- Session listing and Session detail normalization.
- Delegate and wait through completion.
- Recent-session lookup and dedupe reuse.
- Abort or cancellation normalization.

The real-server smoke procedure may remain opt-in because it requires a local authenticated Kimi server and model quota.

## Documentation

Update `README.md`, `AGENTS.md`, and `docs/prompts/kimi-delegate-workflow.md` to:

- State that the bridge supports both legacy Kimi status responses and Kimi 0.27+ state facts.
- Document the additive `failed` status and recommended recovery flow.
- Keep the normal user prompt and dedupe workflow unchanged.
- Note that `/api/v2` and `@moonshot-ai/klient` are a possible future migration, not part of this compatibility release.

## Acceptance Criteria

1. Legacy Session responses with `status` continue to drive every Bridge lifecycle tool correctly.
2. Kimi 0.27 Session responses with `busy`, `pending_interaction`, and `last_turn_reason` drive every Bridge lifecycle tool correctly.
3. Unknown or malformed state cannot be mistaken for successful completion.
4. `failed` is returned as an explicit terminal status and never receives a success `reviewPackage`.
5. `aborted` and `failed` sessions are not automatically reused by dedupe.
6. Recent-session status filtering behaves consistently against old and new servers.
7. Approval and question details remain available when blocked.
8. Existing session IDs, prompt IDs, Web URLs, handoff fields, and successful idle behavior remain compatible.
9. No real token is committed or emitted by diagnostics and tests.
10. `pnpm test`, `pnpm typecheck`, `pnpm build`, and plugin validation pass.
11. An authenticated Kimi 0.27 real-server smoke test confirms delegate, wait, handoff, recent-session recovery, dedupe, and cancellation behavior.

## Rollout

After implementation and Codex review:

1. Build the bridge.
2. Reinstall `kimi-delegate@codex-kimi-bridge-local`.
3. Restart Codex or open a new task to refresh MCP tool definitions.
4. Run the Kimi 0.27 real-server smoke flow.
5. Confirm `kimi_recent_sessions`, `kimi_find_recent_session`, and `kimi_delegate_and_wait.dedupe` return normalized statuses.

Migration to `@moonshot-ai/klient` should be evaluated separately after this compatibility layer has been dogfooded.
