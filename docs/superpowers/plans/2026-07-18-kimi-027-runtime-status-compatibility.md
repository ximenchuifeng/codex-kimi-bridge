# Kimi 0.27 Runtime Status Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Bridge lifecycle tool work against both legacy Kimi `status` responses and Kimi 0.27+ `busy`/`pending_interaction`/`last_turn_reason` responses, with an explicit terminal `failed` status.

**Architecture:** Add one structural status normalizer and make `KimiClient` return normalized Session resources. Wait, handoff, recent-session recovery, and dedupe consume only the normalized status. Server metadata remains diagnostic; no runtime behavior branches on a version string.

**Tech Stack:** TypeScript, Node.js, Vitest, MCP SDK, Zod, Kimi `/api/v1` REST envelope.

## Global Constraints

- Support both legacy Kimi Session responses containing `status` and Kimi 0.27+ Session responses containing `busy`, `pending_interaction`, and `last_turn_reason`.
- Add `failed` as an additive public terminal status; preserve every existing status name and successful idle result field.
- Do not migrate to `/api/v2` or add `@moonshot-ai/klient` in this change.
- Do not change Kimi Code server or Codex plugin installation mechanics.
- Do not automatically answer approvals or questions.
- Do not leak tokens, authorization headers, or token-bearing URLs.
- Unknown or malformed state must fail clearly and must never be interpreted as `idle`.
- Use TDD for every behavioral change and keep commits scoped to the task that introduced the behavior.

---

## File Map

- Create `src/kimi/runtime-status.ts`: compatibility input schema and the only runtime-status normalizer.
- Create `test/runtime-status.test.ts`: table-driven mapping and malformed-input coverage.
- Modify `src/kimi/types.ts`: raw/normalized Session types, `failed`, `/meta`, and list result types.
- Modify `src/kimi/client.ts`: normalize create/get/list responses, add `getRuntimeStatus`, client-side status filtering, and `/meta` access.
- Modify `src/kimi/wait.ts`: accept `failed` as a terminal result.
- Modify `src/tools.ts`: use normalized status for wait/handoff/recent/dedupe and emit failed diagnostics.
- Modify `src/preflight.ts`: add optional safe server metadata fields to `BridgeStatus` only.
- Modify `test/client.test.ts`, `test/wait.test.ts`, and `test/tools.test.ts`: compatibility and tool behavior.
- Modify `test/fixtures/fake-kimi-server.ts` and `test/integration.test.ts`: Kimi 0.27 default fixture and HTTP integration assertions.
- Modify `README.md`, `AGENTS.md`, and `docs/prompts/kimi-delegate-workflow.md`: compatibility and failed recovery guidance.

---

### Task 1: Introduce The Runtime Status Normalizer

**Files:**
- Create: `src/kimi/runtime-status.ts`
- Create: `test/runtime-status.test.ts`
- Modify: `src/kimi/types.ts:11-35`
- Modify: `src/kimi/wait.ts:1-15`

**Interfaces:**
- Consumes: raw Session fields `status`, `busy`, `pending_interaction`, and `last_turn_reason`.
- Produces: `BridgeRuntimeStatus`, `SessionStateFacts`, and `normalizeRuntimeStatus(facts)` for the client and tools.

- [ ] **Step 1: Write the table-driven failing normalizer tests**

Create `test/runtime-status.test.ts` with these cases:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeRuntimeStatus } from '../src/kimi/runtime-status.js';

describe('normalizeRuntimeStatus', () => {
  it.each([
    [{ status: 'idle' }, 'idle'],
    [{ status: 'running' }, 'running'],
    [{ status: 'awaiting_approval' }, 'awaiting_approval'],
    [{ status: 'awaiting_question' }, 'awaiting_question'],
    [{ status: 'aborted' }, 'aborted'],
    [{ status: 'failed' }, 'failed'],
    [{ busy: true, pending_interaction: 'none' }, 'running'],
    [{ busy: true, pending_interaction: 'approval' }, 'awaiting_approval'],
    [{ busy: true, pending_interaction: 'question' }, 'awaiting_question'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'completed' }, 'idle'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'cancelled' }, 'aborted'],
    [{ busy: false, pending_interaction: 'none', last_turn_reason: 'failed' }, 'failed'],
    [{ busy: false, pending_interaction: 'none' }, 'idle'],
    [{ status: 'running', busy: false, last_turn_reason: 'completed' }, 'running'],
  ] as const)('normalizes %o to %s', (input, expected) => {
    expect(normalizeRuntimeStatus(input)).toBe(expected);
  });

  it.each([
    {},
    { status: 'paused' },
    { busy: 'yes' },
    { busy: false, pending_interaction: 'confirm' },
    { busy: false, pending_interaction: 'none', last_turn_reason: 'unknown' },
  ])('rejects an unrecognized state shape: %o', (input) => {
    expect(() => normalizeRuntimeStatus(input)).toThrow(/Kimi session state|fields/);
  });

  it('does not include state values in its compatibility error', () => {
    expect(() => normalizeRuntimeStatus({ status: 'secret-value' })).toThrow(
      'Unsupported Kimi session state fields: status',
    );
  });
});
```

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run:

```bash
pnpm vitest run test/runtime-status.test.ts
```

Expected: FAIL because `src/kimi/runtime-status.ts` does not exist.

- [ ] **Step 3: Implement the structural normalizer**

Create `src/kimi/runtime-status.ts`:

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

const LEGACY_STATUSES = new Set<BridgeRuntimeStatus>([
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
  'failed',
]);

function unsupported(facts: SessionStateFacts): Error {
  const fields = Object.keys(facts).sort().join(', ') || '(none)';
  return new Error(`Unsupported Kimi session state fields: ${fields}`);
}

export function normalizeRuntimeStatus(facts: SessionStateFacts): BridgeRuntimeStatus {
  if (typeof facts.status === 'string' && LEGACY_STATUSES.has(facts.status as BridgeRuntimeStatus)) {
    return facts.status as BridgeRuntimeStatus;
  }

  if (facts.pending_interaction === 'approval') return 'awaiting_approval';
  if (facts.pending_interaction === 'question') return 'awaiting_question';
  if (facts.pending_interaction !== undefined && facts.pending_interaction !== 'none') {
    throw unsupported(facts);
  }

  if (facts.busy === true) return 'running';
  if (facts.busy !== false) throw unsupported(facts);

  if (facts.last_turn_reason === undefined || facts.last_turn_reason === 'completed') return 'idle';
  if (facts.last_turn_reason === 'cancelled') return 'aborted';
  if (facts.last_turn_reason === 'failed') return 'failed';
  throw unsupported(facts);
}
```

- [ ] **Step 4: Replace wire-only status assumptions with compatibility types**

In `src/kimi/types.ts`, import `BridgeRuntimeStatus` and replace the Session/status definitions with:

```ts
import type { BridgeRuntimeStatus } from './runtime-status.js';

export interface WireSession {
  id: string;
  title: string;
  status?: unknown;
  busy?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
  metadata: { cwd: string; [key: string]: unknown };
  agent_config: Record<string, unknown>;
  last_seq: number;
}

export type RuntimeSession = Omit<WireSession, 'status'> & {
  status: BridgeRuntimeStatus;
};

export interface SessionStatus {
  status?: unknown;
  busy?: unknown;
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}
```

Change `RecentSession.status` to `BridgeRuntimeStatus` and `ListSessionsResult.items` to `RuntimeSession[]`.

In `src/kimi/wait.ts`, replace the local status union with the shared type and add `failed` to the terminal result:

```ts
import type { BridgeRuntimeStatus } from './runtime-status.js';
import type { PendingApproval, PendingQuestion } from './types.js';

export type KimiSessionRuntimeStatus = BridgeRuntimeStatus;

export type WaitUntilIdleResult =
  | { status: 'idle' | 'aborted' | 'failed' | 'timeout' | 'running' }
  | { status: 'awaiting_approval'; approvals?: PendingApproval[] }
  | { status: 'awaiting_question'; questions?: PendingQuestion[] };
```

- [ ] **Step 5: Add and run the failed terminal wait test**

Add to `test/wait.test.ts`:

```ts
it('returns failed as a terminal status', async () => {
  const pollStatus = vi.fn(async () => ({ status: 'failed' as const }));
  const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 5000, pollStatus });
  await vi.advanceTimersByTimeAsync(0);

  await expect(promise).resolves.toEqual({ status: 'failed' });
  expect(pollStatus).toHaveBeenCalledTimes(1);
});
```

Run:

```bash
pnpm vitest run test/runtime-status.test.ts test/wait.test.ts
pnpm typecheck
```

Expected: both test files pass and TypeScript reports no errors.

- [ ] **Step 6: Commit the normalizer**

```bash
git add src/kimi/runtime-status.ts src/kimi/types.ts src/kimi/wait.ts test/runtime-status.test.ts test/wait.test.ts
git commit -m "feat: normalize Kimi runtime status contracts"
```

---

### Task 2: Normalize Kimi Client Session Responses

**Files:**
- Modify: `src/kimi/client.ts:1-120`
- Modify: `src/kimi/types.ts:38-85`
- Modify: `test/client.test.ts:1-110`

**Interfaces:**
- Consumes: `normalizeRuntimeStatus(WireSession)` from Task 1.
- Produces: normalized `createSession`, `getSession`, `getRuntimeStatus`, `listSessions`, and `getMeta` client methods.

- [ ] **Step 1: Replace old client list tests with old/new normalization tests**

Add these cases to `test/client.test.ts` and update existing fixture objects to satisfy `WireSession`:

```ts
it('normalizes legacy and Kimi 0.27 session resources', async () => {
  const get = vi.fn(async (path: string) => {
    if (path === '/sessions/legacy') {
      return { id: 'legacy', title: 'old', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 };
    }
    return {
      id: 'modern',
      title: 'new',
      busy: false,
      pending_interaction: 'question',
      metadata: { cwd: '/repo' },
      agent_config: { model: '' },
      last_seq: 0,
    };
  }) as HttpPort['get'];
  const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

  await expect(client.getRuntimeStatus('legacy')).resolves.toBe('running');
  await expect(client.getRuntimeStatus('modern')).resolves.toBe('awaiting_question');
});

it('filters normalized session statuses client-side for Kimi 0.27', async () => {
  const get = vi.fn(async () => ({
    items: [
      { id: 's1', title: 'running', busy: true, pending_interaction: 'none', metadata: { cwd: '/repo' }, agent_config: { model: '' }, last_seq: 0 },
      { id: 's2', title: 'failed', busy: false, pending_interaction: 'none', last_turn_reason: 'failed', metadata: { cwd: '/repo' }, agent_config: { model: '' }, last_seq: 0 },
      { id: 's3', title: 'idle', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
    ],
  })) as HttpPort['get'];
  const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

  const result = await client.listSessions({ pageSize: 1, status: 'failed' });

  expect(get).toHaveBeenCalledWith('/sessions', {
    page_size: 100,
    include_archive: undefined,
    exclude_empty: undefined,
  });
  expect(result.items.map((session) => [session.id, session.status])).toEqual([['s2', 'failed']]);
});

it('preserves the requested page size when no status filter is used', async () => {
  const get = vi.fn(async () => ({ items: [] })) as HttpPort['get'];
  const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

  await client.listSessions({ pageSize: 5, includeArchive: true, excludeEmpty: true });

  expect(get).toHaveBeenCalledWith('/sessions', {
    page_size: 5,
    include_archive: true,
    exclude_empty: true,
  });
});

it('reads safe Kimi server metadata', async () => {
  const get = vi.fn(async () => ({ server_version: '0.27.0', backend: 'v2' })) as HttpPort['get'];
  const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

  await expect(client.getMeta()).resolves.toEqual({ server_version: '0.27.0', backend: 'v2' });
  expect(get).toHaveBeenCalledWith('/meta');
});
```

- [ ] **Step 2: Run the client tests and verify they fail against the old API**

```bash
pnpm vitest run test/client.test.ts
```

Expected: FAIL because `getRuntimeStatus` and `getMeta` do not exist and listing still sends `status` to the server.

- [ ] **Step 3: Add metadata and normalized client types**

Add to `src/kimi/types.ts`:

```ts
export interface KimiServerMeta {
  server_version?: string;
  backend?: string;
}

export interface ListSessionsResult {
  items: RuntimeSession[];
}
```

- [ ] **Step 4: Normalize every Session returned by the client**

In `src/kimi/client.ts`, import the new types and normalizer, then implement:

```ts
import { normalizeRuntimeStatus, type BridgeRuntimeStatus } from './runtime-status.js';
import type {
  KimiServerMeta,
  RuntimeSession,
  WireSession,
} from './types.js';

const MAX_SESSION_LIST_PAGE_SIZE = 100;

function normalizeSession(session: WireSession): RuntimeSession {
  const { status: _wireStatus, ...rest } = session;
  return {
    ...rest,
    status: normalizeRuntimeStatus(session),
  };
}
```

Replace the affected methods with:

```ts
async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
  const session = await this.http.post<WireSession>('/sessions', {
    ...(input.title ? { title: input.title } : {}),
    metadata: { cwd: input.cwd },
  });
  return normalizeSession(session);
}

async getSession(sessionId: string): Promise<RuntimeSession> {
  const session = await this.http.get<WireSession>(`/sessions/${encodeURIComponent(sessionId)}`);
  return normalizeSession(session);
}

async getRuntimeStatus(sessionId: string): Promise<BridgeRuntimeStatus> {
  return (await this.getSession(sessionId)).status;
}

getMeta(): Promise<KimiServerMeta> {
  return this.http.get('/meta');
}

async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
  const requestedPageSize = input.pageSize ?? 20;
  const page = await this.http.get<{ items: WireSession[] }>('/sessions', {
    page_size: input.status === undefined ? requestedPageSize : MAX_SESSION_LIST_PAGE_SIZE,
    include_archive: input.includeArchive,
    exclude_empty: input.excludeEmpty,
  });
  const normalized = page.items.map(normalizeSession);
  const filtered = input.status === undefined
    ? normalized
    : normalized.filter((session) => session.status === input.status);
  return { items: filtered.slice(0, requestedPageSize) };
}
```

Keep `getStatus` only for telemetry compatibility; do not use it for lifecycle state.

- [ ] **Step 5: Run focused and full client verification**

```bash
pnpm vitest run test/runtime-status.test.ts test/client.test.ts test/wait.test.ts
pnpm typecheck
```

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 6: Commit the client compatibility layer**

```bash
git add src/kimi/client.ts src/kimi/types.ts test/client.test.ts
git commit -m "fix: normalize Kimi session responses in client"
```

---

### Task 3: Route Every Lifecycle Tool Through Normalized Status

**Files:**
- Modify: `src/tools.ts:1-790`
- Modify: `test/tools.test.ts:1-2055`

**Interfaces:**
- Consumes: `KimiClient.getRuntimeStatus`, normalized `KimiClient.getSession`, and `BridgeRuntimeStatus`.
- Produces: correct wait, handoff, recent/find, dedupe, and failed diagnostics behavior.

- [ ] **Step 1: Add failing tool tests for Kimi 0.27 and failed behavior**

Add focused tests to `test/tools.test.ts`:

```ts
it('polls getRuntimeStatus instead of the legacy status response', async () => {
  const getRuntimeStatus = vi.fn()
    .mockResolvedValueOnce('running')
    .mockResolvedValueOnce('idle');
  const kimi = { ...makeKimi(), getRuntimeStatus };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const promise = handlers.kimi_wait_until_idle({ sessionId: 's1', timeoutMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);

  await expect(promise).resolves.toEqual({ status: 'idle' });
  expect(getRuntimeStatus).toHaveBeenCalledWith('s1');
});

it('returns diagnostics and no review package when the delegated session fails', async () => {
  const kimi = {
    ...makeKimi(),
    getRuntimeStatus: vi.fn(async () => 'failed'),
    listMessages: vi.fn(async () => [{ role: 'assistant', content: 'implementation failed' }]),
  };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'Kimi 0.27 compatibility',
    acceptanceCriteria: [],
    plan: [],
    timeoutMs: 1000,
  });

  expect(result.wait).toEqual({ status: 'failed' });
  expect(result.reviewPackage).toBeUndefined();
  expect(result.handoff).toBeUndefined();
  expect(result.diagnostics?.lastAssistantMessage).toBe('implementation failed');
  expect(result.diagnostics?.suggestedNextActions.join(' ')).toContain('webUrl');
});

it('builds handoff status from the normalized Session resource', async () => {
  const kimi = {
    ...makeKimi(),
    getSession: vi.fn(async () => ({
      id: 's1', title: 'test', status: 'failed', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0,
    })),
    listMessages: vi.fn(async () => []),
    getGitStatus: vi.fn(async () => ({ entries: {}, additions: 0, deletions: 0 })),
  };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  await expect(handlers.kimi_get_handoff({ sessionId: 's1' })).resolves.toMatchObject({ status: 'failed' });
});

it('does not automatically reuse a failed dedupe match', async () => {
  const kimi = {
    ...makeKimi(),
    listSessions: vi.fn(async () => ({
      items: [{ id: 's2', title: 'Kimi 0.27 compatibility', status: 'failed', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
    })),
  };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'Kimi 0.27 compatibility retry',
    acceptanceCriteria: [],
    plan: [],
    dedupe: { titleContains: 'Kimi 0.27 compatibility', reuseIfStatus: ['failed'] },
  });

  expect(result.dedupe).toMatchObject({ matched: true, reused: false, reason: 'status_not_supported' });
});
```

Update `makeKimi()` so its default lifecycle method is:

```ts
getRuntimeStatus: vi.fn(async () => 'idle'),
```

Keep `getStatus` only in tests that explicitly exercise telemetry; replace lifecycle mocks with `getRuntimeStatus`.

- [ ] **Step 2: Run the focused tool tests and verify failures**

```bash
pnpm vitest run test/tools.test.ts
```

Expected: FAIL because tools still call `getStatus` and failed diagnostics are not supported.

- [ ] **Step 3: Update wait and diagnostics to support failed**

In `src/tools.ts`, poll the normalized method:

```ts
pollStatus: async () => ({ status: await deps.kimi.getRuntimeStatus(input.sessionId) }),
```

Change diagnostics status to:

```ts
status: 'timeout' | 'aborted' | 'failed',
```

Use explicit suggested actions:

```ts
const suggestedNextActions = status === 'timeout'
  ? [
      'wait 状态为 timeout，可继续调用 kimi_wait_until_idle 等待同一 session。',
      `或在浏览器中打开 webUrl ${webUrl} 查看实时进度。`,
    ]
  : status === 'failed'
    ? [
        'wait 状态为 failed，请在浏览器中打开 webUrl 查看失败原因。',
        `webUrl: ${webUrl}`,
        '修正原因后使用 kimi_continue_task 继续同一 session。',
      ]
    : [
        'wait 状态为 aborted，可在浏览器中打开 webUrl 查看中断原因。',
        `webUrl: ${webUrl}`,
        '必要时使用 kimi_continue_task 重试或补充指令。',
      ];
```

Generate diagnostics when:

```ts
if (wait.status === 'timeout' || wait.status === 'aborted' || wait.status === 'failed') {
```

- [ ] **Step 4: Use the normalized Session in handoff and recent-session output**

Remove `deps.kimi.getStatus` from the handoff `Promise.all`. Use:

```ts
const [messages, gitStatus, session] = await Promise.all([
  deps.kimi.listMessages(input.sessionId),
  deps.kimi.getGitStatus(input.sessionId),
  deps.kimi.getSession(input.sessionId),
]);
```

Build the handoff with:

```ts
return buildHandoff({
  messages,
  gitStatus,
  diffs,
  waitStatus: session.status,
  changedFiles,
});
```

`buildRecentSession` continues copying `session.status`, which is now normalized by `KimiClient.listSessions`.

Add a `failed` branch to `buildFindSuggestions`:

```ts
case 'failed':
  return [
    `找到执行失败的 session ${match.sessionId}。`,
    `在浏览器中打开 ${match.webUrl} 查看失败原因。`,
    '修正原因后使用 kimi_continue_task 继续旧 session，不要自动创建重复 session。',
  ];
```

Keep the dedupe-supported set exactly:

```ts
const supportedDedupeReuseStatuses: Array<RecentSession['status']> = [
  'running',
  'idle',
  'awaiting_approval',
  'awaiting_question',
];
```

- [ ] **Step 5: Run all lifecycle tool tests**

```bash
pnpm vitest run test/wait.test.ts test/tools.test.ts
pnpm typecheck
```

Expected: all lifecycle tests pass; no lifecycle test requires `getStatus().status`.

- [ ] **Step 6: Commit lifecycle tool compatibility**

```bash
git add src/tools.ts test/tools.test.ts
git commit -m "fix: use normalized Kimi lifecycle status"
```

---

### Task 4: Make Integration Fixtures Match Kimi 0.27

**Files:**
- Modify: `test/fixtures/fake-kimi-server.ts:12-60`
- Modify: `test/integration.test.ts:13-40`

**Interfaces:**
- Consumes: normalized `KimiClient` methods.
- Produces: HTTP-level evidence that the Bridge accepts the Kimi 0.27 envelope and Session field shape.

- [ ] **Step 1: Update the fake server Session and status responses**

Define one Kimi 0.27 Session object in `startFakeKimiServer`:

```ts
const session = {
  id: 's1',
  workspace_id: 'workspace_1',
  title: 'test',
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
  busy: false,
  main_turn_active: false,
  pending_interaction: 'none',
  last_turn_reason: 'completed',
  archived: false,
  metadata: { cwd: '/repo' },
  agent_config: { model: '' },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0,
    context_tokens: 0,
    context_limit: 0,
    turn_count: 0,
  },
  permission_rules: [],
  message_count: 1,
  last_seq: 1,
};
```

Return `session` from POST/GET Session routes. Add:

```ts
if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/status') {
  res.end(envelope({
    busy: false,
    model: 'kimi-k2',
    thinking_level: 'high',
    permission: 'auto',
    plan_mode: false,
    swarm_mode: false,
    context_tokens: 0,
    max_context_tokens: 262144,
    context_usage: 0,
  }));
  return;
}

if (req.method === 'GET' && req.url === '/api/v1/meta') {
  res.end(envelope({ server_version: '0.27.0', backend: 'v2' }));
  return;
}
```

- [ ] **Step 2: Add HTTP-level runtime assertions**

Add to `test/integration.test.ts` after Session creation:

```ts
expect(session.status).toBe('idle');
await expect(kimi.getRuntimeStatus(session.id)).resolves.toBe('idle');
await expect(kimi.getMeta()).resolves.toEqual({ server_version: '0.27.0', backend: 'v2' });
```

- [ ] **Step 3: Run the integration test**

```bash
pnpm vitest run test/integration.test.ts
```

Expected: PASS against the default Kimi 0.27 fixture.

- [ ] **Step 4: Run the complete suite to catch stale legacy mocks**

```bash
pnpm test
```

Expected: every test passes. Any remaining test fixture that represents a Kimi 0.27 Session uses the new facts; only tests explicitly named as legacy compatibility cases retain raw `status`.

- [ ] **Step 5: Commit the realistic fixtures**

```bash
git add test/fixtures/fake-kimi-server.ts test/integration.test.ts
git commit -m "test: mirror Kimi 0.27 session contracts"
```

---

### Task 5: Expose Safe Server Metadata And Document Recovery

**Files:**
- Modify: `src/preflight.ts:8-25`
- Modify: `src/tools.ts:541-545`
- Modify: `test/tools.test.ts:63-110`
- Modify: `README.md:40-310`
- Modify: `AGENTS.md:55-135`
- Modify: `docs/prompts/kimi-delegate-workflow.md:1-180`

**Interfaces:**
- Consumes: `KimiClient.getMeta` and existing `KimiPreflight.getStatus`.
- Produces: optional `serverVersion` and `backend` in `kimi_bridge_status`, plus documented `failed` recovery.

- [ ] **Step 1: Add failing metadata status tests**

Add to `test/tools.test.ts`:

```ts
it('adds safe Kimi metadata to a ready bridge status', async () => {
  const kimi = { ...makeKimi(), getMeta: vi.fn(async () => ({ server_version: '0.27.0', backend: 'v2' })) };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_bridge_status();

  expect(result.serverVersion).toBe('0.27.0');
  expect(result.backend).toBe('v2');
});

it('keeps bridge status available when meta cannot be read', async () => {
  const kimi = { ...makeKimi(), getMeta: vi.fn(async () => { throw new Error('meta unavailable'); }) };
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_bridge_status();

  expect(result.status).toBe('ready');
  expect(result.serverVersion).toBeUndefined();
  expect(result.diagnostics).toContain('meta unavailable');
});
```

- [ ] **Step 2: Run focused tests and verify metadata is missing**

```bash
pnpm vitest run test/tools.test.ts
```

Expected: FAIL because `BridgeStatus` and `kimi_bridge_status` do not expose metadata.

- [ ] **Step 3: Add optional metadata fields and best-effort enrichment**

Add to `BridgeStatus` in `src/preflight.ts`:

```ts
serverVersion?: string;
backend?: string;
```

Replace the tool handler with:

```ts
async kimi_bridge_status() {
  const status = await deps.preflight.getStatus();
  if (!status.healthzOk || !status.authOk) return status;
  try {
    const meta = await deps.kimi.getMeta();
    return {
      ...status,
      ...(meta.server_version ? { serverVersion: meta.server_version } : {}),
      ...(meta.backend ? { backend: meta.backend } : {}),
    };
  } catch {
    return {
      ...status,
      diagnostics: [...status.diagnostics, 'meta unavailable'],
    };
  }
}
```

Do not include the raw metadata error because transport errors may contain unsafe dynamic text.

- [ ] **Step 4: Update README and workflow documentation with exact behavior**

Add these statements in the relevant status/recovery sections:

```text
The bridge accepts both legacy Kimi Session `status` responses and Kimi 0.27+ `busy` / `pending_interaction` / `last_turn_reason` responses.

`failed` is a terminal Bridge status. A failed delegate does not produce a successful `reviewPackage`; open `webUrl`, inspect the failure, and use `kimi_continue_task` to continue the same session when recovery is appropriate. `failed` and `aborted` sessions are never automatically reused by dedupe.

`kimi_bridge_status` may include `serverVersion` and `backend` from `/api/v1/meta`. These fields are diagnostic only and never select the compatibility path.
```

Update the status lists in `README.md`, `AGENTS.md`, and `docs/prompts/kimi-delegate-workflow.md` to include `failed`. Keep the default dedupe reusable list unchanged.

- [ ] **Step 5: Run metadata, documentation, and token-leak checks**

```bash
pnpm vitest run test/tools.test.ts
pnpm typecheck
rg -n "failed|serverVersion|backend|Kimi 0.27" README.md AGENTS.md docs/prompts/kimi-delegate-workflow.md
git diff --check
```

Expected: tests and typecheck pass; all three documents mention failed recovery; `git diff --check` produces no output.

- [ ] **Step 6: Commit diagnostics and docs**

```bash
git add src/preflight.ts src/tools.ts test/tools.test.ts README.md AGENTS.md docs/prompts/kimi-delegate-workflow.md
git commit -m "feat: expose Kimi compatibility diagnostics"
```

---

### Task 6: Full Verification And Real Kimi 0.27 Contract Smoke

**Files:**
- Modify only if verification exposes a scoped defect in files already listed in this plan.

**Interfaces:**
- Consumes: the complete implementation from Tasks 1-5.
- Produces: verification evidence and a handoff package for Codex review.

- [ ] **Step 1: Run the complete local verification suite**

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected:

- All Vitest files and tests pass.
- TypeScript typecheck exits 0.
- Build exits 0.
- Plugin validation prints `Plugin validation passed`.

- [ ] **Step 2: Check the final diff and commit boundaries**

```bash
git status --short
git diff --check HEAD~5..HEAD
git log --oneline -6
```

Expected: no uncommitted implementation files, no whitespace errors, and the scoped commits from Tasks 1-5 are present.

- [ ] **Step 3: Run an authenticated real-server shape check without printing a token**

The Kimi implementation session already requires a running authenticated server. Confirm it is still running:

```bash
kimi server ps
```

Then run this read-only shape check. It reads the token internally from `KIMI_CODE_HOME` or the default Kimi home and prints only field names plus non-secret state values:

```bash
node --input-type=module -e '
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const kimiHome = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
const token = (await readFile(join(kimiHome, "server.token"), "utf8")).trim();
const headers = { authorization: `Bearer ${token}` };
const request = async (path) => {
  const response = await fetch(`http://127.0.0.1:58627/api/v1${path}`, { headers });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`request failed: ${path}`);
  return envelope.data;
};

const meta = await request("/meta");
const page = await request("/sessions?page_size=1&exclude_empty=false");
const session = page.items[0];
const detail = session ? await request(`/sessions/${encodeURIComponent(session.id)}`) : undefined;
const status = session ? await request(`/sessions/${encodeURIComponent(session.id)}/status`) : undefined;
console.log(JSON.stringify({
  meta: { serverVersion: meta.server_version, backend: meta.backend },
  listKeys: session ? Object.keys(session).sort() : [],
  listState: session ? { busy: session.busy, pendingInteraction: session.pending_interaction, lastTurnReason: session.last_turn_reason } : null,
  detailKeys: detail ? Object.keys(detail).sort() : [],
  statusKeys: status ? Object.keys(status).sort() : [],
}, null, 2));
'
```

Verify:

```text
GET /api/v1/meta -> server_version 0.27.x and backend v2
GET /api/v1/sessions -> items contain busy/pending_interaction and normalize successfully
GET /api/v1/sessions/{id} -> normalizes without a raw status field
GET /api/v1/sessions/{id}/status -> contains busy and does not need status.status
```

No command output may contain the token, an Authorization header, or `#token=` URL.

- [ ] **Step 4: Report the bootstrap limitation honestly**

Because the installed Bridge process is the version being fixed, do not claim its old `kimi_wait_until_idle` behavior proves the fix. Return the implementation session ID and Web URL. Codex must build, reinstall the updated plugin, restart Codex, and then run the post-install delegate/wait/dedupe/abort smoke test.

- [ ] **Step 5: Return the Kimi handoff for Codex review**

The final response must contain:

```text
1. Commits in order
2. Modified and created files
3. Test, typecheck, build, and plugin validation results
4. Runtime-status mapping summary
5. Real Kimi 0.27 response-shape evidence with no secrets
6. Deviations from this plan
7. Known risks and the required post-reinstall smoke test
8. Confirmation that no real token was committed or printed
9. Waiting for Codex review
```

Do not reinstall the Codex plugin from the Kimi implementation session. Codex performs review first, then commits any review fixes, rebuilds, reinstalls, restarts, and runs the true end-to-end smoke flow.

---

## Codex Review Checklist

- Confirm every lifecycle decision uses normalized Session state rather than `getStatus().status`.
- Confirm the normalizer rejects unknown shapes and does not expose raw values in errors.
- Confirm `failed` is terminal and never produces a success `reviewPackage`.
- Confirm failed/aborted dedupe matches are not reused.
- Confirm status-filtered listing omits the obsolete `status` query and filters normalized results.
- Confirm pending approval/question details still work.
- Confirm metadata is diagnostic only and best-effort.
- Confirm old-contract tests and realistic Kimi 0.27 fixtures both exist.
- Confirm documentation leaves the normal dedupe reusable set unchanged.
- Independently run all four verification commands before acceptance.

## Post-Install Smoke Flow

After Codex accepts the implementation:

```bash
pnpm build
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Restart Codex or open a new task, then verify in order:

1. `kimi_bridge_status` reports `ready`, `serverVersion`, and `backend` when `/meta` is available.
2. `kimi_recent_sessions` returns defined normalized statuses.
3. Delegate a no-change Kimi task and confirm `kimi_delegate_and_wait` stays in `running` until completion, then returns `idle` with `reviewPackage`.
4. Use the same stable title with dedupe and confirm the completed session is reused without creating a duplicate.
5. Start a disposable long-running no-file-change task, abort it, and confirm later observation normalizes cancellation to `aborted`.
6. Confirm no token appears in any tool result or Web URL.
