# Codex Kimi Bridge Design

Date: 2026-07-06

## Goal

Build a local Codex plugin and MCP bridge that lets Codex act as the coordinator/reviewer while Kimi Code acts as the fast implementation worker. The bridge removes the current manual copy-paste loop between Codex and Kimi.

The intended collaboration model is:

1. Codex creates the spec, plan, acceptance criteria, and review loop.
2. Codex delegates implementation work to Kimi through a structured MCP tool call.
3. Kimi executes the task in a Kimi session, optionally using Kimi AgentSwarm internally.
4. The bridge returns Kimi's transcript, status, changed files, diffs, test output, and handoff.
5. Codex reviews the result and either delegates a follow-up task to Kimi or marks the feature complete.

## Product Shape

The first version is a Codex-controlled loop, not a symmetric agent-to-agent network.

Codex remains the only coordinator. Kimi is treated as an execution backend. This keeps authority, review, and final completion decisions in one place while still letting Kimi use its own subagents and swarm mode for implementation speed.

## Architecture

```text
Codex
  |
  | MCP tools
  v
codex-kimi-bridge MCP server
  |
  | REST /api/v1 + WebSocket /api/v1/ws
  v
Kimi local server
  |
  v
Kimi Code agent
  |
  v
optional AgentSwarm subagents
```

The bridge should use Kimi's local REST/WebSocket server rather than the ACP interface for the MVP. Kimi Web already uses this protocol, and it exposes the control surface needed for a coordinator:

- sessions
- prompts
- session status
- approvals
- questions
- messages
- tasks
- snapshots
- git status
- file diffs

ACP remains a possible later adapter, but it is primarily an editor/client to coding-agent protocol. The REST/WS server is a better fit for "delegate, wait, inspect, continue".

## Kimi Server Protocol

Kimi Web confirms the browser protocol:

- REST base: `/api/v1`
- WebSocket: `/api/v1/ws`
- REST responses are envelopes: `{ code, msg, data, request_id }`
- Prompt submission requires model/runtime fields, not only content:
  - `content`
  - `model`
  - `thinking`
  - `permission_mode`
  - `plan_mode`
  - optional `swarm_mode`

The bridge should copy the web client's important protocol behavior:

- unwrap REST envelopes and fail on non-zero `code`
- use WebSocket cursors for session event streaming
- fall back to session snapshot when `resync_required` is received
- treat session status as authoritative for `running`, `idle`, `awaiting_approval`, and `awaiting_question`

## Codex Plugin Components

The Codex plugin should contain:

- `skills/kimi-delegate/SKILL.md`
  - Describes when Codex should delegate to Kimi.
  - Defines the coordinator/reviewer workflow.
  - Requires Codex to keep ownership of spec, plan, verification, and completion.

- `.mcp.json`
  - Registers the local MCP bridge.

- `scripts/` or `packages/bridge`
  - Implements the MCP server and Kimi REST/WS client.

The MCP server should be usable both from the plugin and directly during development.

## MCP Tool Surface

Initial tools:

- `kimi_delegate_task`
  - Creates or reuses a Kimi session and submits a task.
  - Inputs: `cwd`, `task`, `acceptanceCriteria`, `plan`, `swarmMode`, `permissionMode`, `model`, `thinking`, optional `sessionId`.
  - Output: `sessionId`, `promptId`, initial status.

- `kimi_wait_until_idle`
  - Waits until the Kimi session becomes idle or blocked.
  - Handles WS reconnect and snapshot resync.
  - Output: final status, pending approval/question if blocked.

- `kimi_get_handoff`
  - Collects Kimi's final assistant response, changed files, git status, relevant diffs, task summaries, and commands/tests mentioned in the transcript.
  - Output should be structured and concise enough for Codex review.

- `kimi_continue_task`
  - Sends Codex review feedback or a follow-up implementation request into the same Kimi session.

- `kimi_answer_approval`
  - Resolves a pending Kimi approval when Codex or the user chooses to approve/reject.

- `kimi_answer_question`
  - Resolves a Kimi question.

- `kimi_get_diff`
  - Returns aggregated git status and file diffs for Codex review.

- `kimi_abort`
  - Aborts the active prompt/session if Kimi is stuck or doing the wrong thing.

## Delegation Prompt Contract

Every delegated Kimi task should include a stable coordinator prompt:

```text
You are the implementation worker. Codex is the coordinator and reviewer.

Implement the requested work in this repository. Do not change unrelated files.

Task:
...

Acceptance criteria:
...

Plan from Codex:
...

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
- ...
- ...

When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring Codex review
```

Codex may suggest a swarm split, but Kimi decides whether to call `AgentSwarm`. Codex should not directly orchestrate Kimi's individual swarm subagents.

## Swarm Policy

Use Kimi swarm mode when:

- the work has independent modules, packages, platforms, test areas, or investigation threads
- subagents can inspect or modify disjoint areas
- parallel exploration is valuable before implementation

Avoid swarm mode when:

- the change is small or single-file
- multiple workers would likely edit the same files
- the task requires a strict sequential migration

When enabling swarm, the bridge should set `swarm_mode: true` in the prompt submission and include a suggested split in the task prompt. Kimi's own swarm mode injects instructions that tell it to call `AgentSwarm` with `prompt_template` and `items`.

## Review Loop

The loop is:

1. Codex prepares or updates a spec/plan.
2. Codex calls `kimi_delegate_task`.
3. Bridge waits for Kimi to finish or block.
4. Bridge returns a handoff.
5. Codex reviews:
   - git diff
   - changed files
   - tests
   - acceptance criteria
   - unexpected side effects
6. If review fails, Codex calls `kimi_continue_task` with precise feedback.
7. Repeat until Codex verifies completion.

Codex should run independent verification itself when possible. Kimi's reported tests are useful evidence but not final authority.

## Session And Workspace Strategy

Default MVP behavior:

- Use the target repo `cwd` as the Kimi session workspace.
- Reuse a Kimi session for follow-up tasks on the same feature.
- Create a new Kimi session for unrelated features.

Preferred safer mode for larger work:

- Create a git worktree for Kimi.
- Let Kimi modify only that worktree.
- Codex reviews the worktree diff and decides whether to integrate it.

Worktree mode should become the default once the basic bridge is reliable.

## Error Handling

The bridge should explicitly handle:

- Kimi server not running: start or instruct how to start `kimi server run`
- auth required: surface the Kimi login/server-token requirement
- non-zero REST envelope codes
- WS disconnect and reconnect
- `resync_required`: reload session snapshot
- session blocked on approval/question
- prompt timeout
- Kimi stuck in running state
- no changed files after implementation
- dirty worktree before delegation

Timeouts should produce a structured blocked result rather than hanging Codex.

## Security And Permissions

The MVP should default to `permission_mode: auto` for implementation tasks, not `yolo`.

Rationale:

- `manual` defeats the goal of removing hand-copying.
- `yolo` is too broad for a cross-agent automation loop.
- `auto` allows normal development while still surfacing higher-risk actions.

Codex should not automatically approve destructive or broad commands. Approvals should be summarized to the user or rejected with feedback unless a local allowlist clearly covers them.

## Testing

Unit tests:

- REST envelope unwrap
- Kimi API client URL construction
- prompt payload mapping
- WS frame handling
- status wait state machine
- handoff extraction

Integration tests:

- use a fake Kimi server for deterministic REST/WS behavior
- delegate a task, stream events, complete, and collect handoff
- block on approval and resolve it
- handle `resync_required`

Manual smoke test:

- start Kimi server
- delegate a small repo edit from Codex
- wait for Kimi completion
- inspect returned diff
- send review feedback
- verify follow-up changes

## Non-Goals For MVP

- Direct ACP client implementation.
- Bidirectional autonomous agent-to-agent calling.
- Codex exposing itself as an ACP server.
- Managing individual Kimi AgentSwarm subagents from Codex.
- Cloud or remote multi-user orchestration.
- Fully automatic approval of destructive actions.

## Implementation Order

1. Build a standalone TypeScript Kimi REST client.
2. Add WebSocket event subscription and wait-until-idle.
3. Add MCP server wrapper with `kimi_delegate_task` and `kimi_get_handoff`.
4. Add Codex plugin packaging and skill instructions.
5. Add continuation, approval/question resolution, and diff tools.
6. Add worktree isolation mode.
7. Add richer swarm split prompting and review summaries.

## Success Criteria

The first version is successful when Codex can:

- delegate a concrete implementation task to Kimi without manual copy-paste
- wait until Kimi finishes or blocks
- retrieve a structured handoff and diff
- review the result
- send follow-up feedback to the same Kimi session
- repeat until the feature is complete

