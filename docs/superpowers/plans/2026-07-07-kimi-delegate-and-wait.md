# Kimi Delegate And Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a higher-level `kimi_delegate_and_wait` MCP tool that creates or reuses a Kimi session, submits a task, waits for completion or blocking, and returns the review package Codex needs.

**Architecture:** Reuse the existing delegate, wait, and handoff primitives instead of duplicating Kimi API calls. Keep Codex as the reviewer by returning structured data; do not auto-approve, auto-continue, or modify code outside Kimi's execution.

**Tech Stack:** TypeScript, MCP SDK, Zod, Vitest, existing `KimiClient`, `KimiPreflight`, `waitUntilIdle`, and `buildHandoff` helpers.

## Global Constraints

- Kimi owns implementation execution; Codex owns spec, plan, review, and final acceptance.
- Do not change Kimi server.
- Do not change Codex plugin installation mechanics.
- Preserve existing `kimi_delegate_task`, `kimi_wait_until_idle`, `kimi_get_handoff`, and `kimi_get_diff` behavior.
- `kimi_delegate_and_wait` must preflight once through the existing preflight wrapper.
- Do not leak tokens or include token values in any output.
- Full verification must pass: `pnpm test`, `pnpm typecheck`, `pnpm build`, and `python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate`.

---

## File Structure

- Modify `src/tools.ts`: define input/result interfaces and implement `kimi_delegate_and_wait` by composing existing handler logic.
- Modify `src/index.ts`: register the new MCP tool and Zod schema.
- Modify `test/tools.test.ts`: cover success, timeout, approval blocking, question blocking, existing session reuse, and URL encoding.
- Modify `test/index.test.ts`: cover MCP tool registration if that file currently asserts exposed tools.
- Modify `README.md`: document the new one-call workflow and the returned fields.

---

### Task 1: Tool Handler Contract

**Files:**
- Modify: `src/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `DelegateTaskInput`, `WaitUntilIdleInput`, `KimiHandoff`, `WaitUntilIdleResult`
- Produces:
  - `DelegateAndWaitInput`
  - `DelegateAndWaitResult`
  - `ToolHandlers.kimi_delegate_and_wait`

- [ ] **Step 1: Add a failing test for idle success**

Add a test in `test/tools.test.ts`:

```ts
it('delegates, waits, and returns a handoff when idle', async () => {
  const kimi = makeKimi({
    createSession: vi.fn(async () => ({ id: 's1' })),
    submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
    getStatus: vi.fn(async () => ({ status: 'idle' })),
    listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done\n- src/a.ts' }]),
    getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 4, deletions: 1 })),
    getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
    getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
  });
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'implement x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit src/a.ts'],
    timeoutMs: 1000,
  });

  expect(result).toMatchObject({
    sessionId: 's1',
    promptId: 'p1',
    submitStatus: 'running',
    wait: { status: 'idle' },
    webUrl: 'http://127.0.0.1:58627/sessions/s1',
  });
  expect(result.handoff?.changedFiles).toEqual(['src/a.ts']);
  expect(result.changedFiles).toEqual(['src/a.ts']);
});
```

- [ ] **Step 2: Run the focused failing test**

Run:

```bash
pnpm test -- test/tools.test.ts
```

Expected: TypeScript/test failure because `kimi_delegate_and_wait` is not implemented.

- [ ] **Step 3: Add interfaces and handler**

In `src/tools.ts`, add:

```ts
export interface DelegateAndWaitInput extends DelegateTaskInput {
  timeoutMs?: number;
}

export interface DelegateAndWaitResult {
  sessionId: string;
  promptId: string;
  submitStatus: string;
  webUrl: string;
  wait: WaitUntilIdleResult;
  handoff?: KimiHandoff;
  changedFiles?: string[];
}
```

Extend `ToolHandlers`:

```ts
kimi_delegate_and_wait: (input: DelegateAndWaitInput) => Promise<DelegateAndWaitResult>;
```

Implement it inside `createToolHandlers` by calling existing handlers:

```ts
async kimi_delegate_and_wait(input: DelegateAndWaitInput) {
  const delegated = await handlers.kimi_delegate_task(input);
  const wait = await handlers.kimi_wait_until_idle({
    sessionId: delegated.sessionId,
    timeoutMs: input.timeoutMs,
  });
  if (wait.status !== 'idle') {
    return {
      sessionId: delegated.sessionId,
      promptId: delegated.promptId,
      submitStatus: delegated.status,
      webUrl: delegated.webUrl,
      wait,
    };
  }
  const handoff = await handlers.kimi_get_handoff({ sessionId: delegated.sessionId });
  return {
    sessionId: delegated.sessionId,
    promptId: delegated.promptId,
    submitStatus: delegated.status,
    webUrl: delegated.webUrl,
    wait,
    handoff,
    changedFiles: handoff.changedFiles,
  };
}
```

When returning wrapped handlers, wrap `kimi_delegate_and_wait` with `withPreflight`. To avoid multiple preflights within the composed call, call the unwrapped internal helper functions or factor shared private functions if needed. Acceptance requires exactly one `ensureReady()` call for `kimi_delegate_and_wait`.

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm test -- test/tools.test.ts
```

Expected: the new success test passes.

---

### Task 2: Blocked And Timeout Behavior

**Files:**
- Modify: `test/tools.test.ts`
- Modify: `src/tools.ts`

**Interfaces:**
- Consumes: `WaitUntilIdleResult`
- Produces: no handoff for non-idle wait results

- [ ] **Step 1: Add tests for timeout and blocked states**

Add tests in `test/tools.test.ts`:

```ts
it('returns session details without handoff when delegate_and_wait times out', async () => {
  const kimi = makeKimi({
    getStatus: vi.fn(async () => ({ status: 'running' })),
    listMessages: vi.fn(async () => {
      throw new Error('handoff should not be loaded');
    }),
  });
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 20 }), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'implement x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit code'],
    timeoutMs: 20,
  });

  expect(result.wait).toEqual({ status: 'timeout' });
  expect(result.handoff).toBeUndefined();
  expect(result.changedFiles).toBeUndefined();
  expect(result.sessionId).toBe('s1');
  expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
});

it('returns pending approvals when delegate_and_wait is blocked on approval', async () => {
  const kimi = makeKimi({
    getStatus: vi.fn(async () => ({ status: 'awaiting_approval' })),
    listPendingApprovals: vi.fn(async () => [{ approval_id: 'a1', tool_name: 'Bash' }]),
  });
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'implement x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit code'],
  });

  expect(result.wait).toEqual({
    status: 'awaiting_approval',
    approvals: [{ approval_id: 'a1', tool_name: 'Bash' }],
  });
  expect(result.handoff).toBeUndefined();
});

it('returns pending questions when delegate_and_wait is blocked on a question', async () => {
  const kimi = makeKimi({
    getStatus: vi.fn(async () => ({ status: 'awaiting_question' })),
    listPendingQuestions: vi.fn(async () => [{ question_id: 'q1', questions: [] }]),
  });
  const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'implement x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit code'],
  });

  expect(result.wait).toEqual({
    status: 'awaiting_question',
    questions: [{ question_id: 'q1', questions: [] }],
  });
  expect(result.handoff).toBeUndefined();
});
```

- [ ] **Step 2: Ensure implementation returns early for non-idle**

Confirm the `kimi_delegate_and_wait` implementation does not call `kimi_get_handoff` unless `wait.status === 'idle'`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm test -- test/tools.test.ts
```

Expected: all tool tests pass.

---

### Task 3: Existing Session And Single Preflight

**Files:**
- Modify: `test/tools.test.ts`
- Modify: `src/tools.ts`

**Interfaces:**
- Consumes: `sessionId?: string`
- Produces: no new session when `sessionId` is provided

- [ ] **Step 1: Add tests for existing session reuse and URL encoding**

Add tests in `test/tools.test.ts`:

```ts
it('delegate_and_wait reuses an existing session id', async () => {
  const kimi = makeKimi();
  const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

  const result = await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    sessionId: 'existing/session 1',
    task: 'continue x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit code'],
  });

  expect(kimi.createSession).not.toHaveBeenCalled();
  expect(result.sessionId).toBe('existing/session 1');
  expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/existing%2Fsession%201');
});

it('delegate_and_wait preflights exactly once', async () => {
  const preflight = makePreflight();
  const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });

  await handlers.kimi_delegate_and_wait({
    cwd: '/repo',
    task: 'implement x',
    acceptanceCriteria: ['tests pass'],
    plan: ['edit code'],
  });

  expect(preflight.ensureReady).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Refactor if the composed implementation preflights more than once**

If calling wrapped handlers causes multiple preflights, introduce internal helper functions inside `createToolHandlers`, such as:

```ts
const delegateTask = async (input: DelegateTaskInput) => { /* current delegate implementation */ };
const waitForIdle = async (input: WaitUntilIdleInput) => { /* current wait implementation */ };
const getHandoff = async (input: GetHandoffInput) => { /* current handoff implementation */ };
```

Then expose wrapped handlers individually and implement `delegateAndWait` by composing the internal helpers under a single `withPreflight`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
pnpm test -- test/tools.test.ts
```

Expected: tests pass and preflight count is exactly one.

---

### Task 4: MCP Registration

**Files:**
- Modify: `src/index.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: `handlers.kimi_delegate_and_wait`
- Produces: MCP tool `kimi_delegate_and_wait`

- [ ] **Step 1: Register MCP tool**

In `src/index.ts`, add:

```ts
server.tool(
  'kimi_delegate_and_wait',
  {
    cwd: z.string(),
    task: z.string(),
    acceptanceCriteria: z.array(z.string()),
    plan: z.array(z.string()),
    timeoutMs: z.number().optional(),
    swarmMode: z.boolean().optional(),
    sessionId: z.string().optional(),
    model: z.string().optional(),
    thinking: z.string().optional(),
  },
  async (input) => runToolHandler(() => handlers.kimi_delegate_and_wait(input)),
);
```

Place it after `kimi_delegate_task` so the API order is easy to scan.

- [ ] **Step 2: Update index tests if needed**

If `test/index.test.ts` snapshots or asserts tool names, add `kimi_delegate_and_wait` to the expected list. If it only tests error formatting, no change is needed.

- [ ] **Step 3: Run index tests**

Run:

```bash
pnpm test -- test/index.test.ts test/tools.test.ts
```

Expected: both test files pass.

---

### Task 5: Documentation And Full Verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: MCP tool behavior
- Produces: user-facing docs

- [ ] **Step 1: Document the one-call workflow**

Add a short section near the existing tool usage docs:

```md
### One-call delegate and wait

Use `kimi_delegate_and_wait` when you want the bridge to perform the mechanical delegate/wait/handoff sequence in one MCP call. Codex still reviews the returned handoff and decides whether to accept the work or continue the session.

The result includes:

- `sessionId`, `promptId`, `submitStatus`, and `webUrl`
- `wait`, including `idle`, `timeout`, `awaiting_approval`, or `awaiting_question`
- `handoff` and `changedFiles` only when `wait.status` is `idle`

If the result is `timeout`, keep the `sessionId` and call `kimi_wait_until_idle` or `kimi_get_handoff` later. If it is blocked, resolve the approval/question in Kimi and continue the same session.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected:

```text
pnpm test passes
pnpm typecheck passes
pnpm build passes
Plugin validation passed
```

- [ ] **Step 3: Handoff to Codex**

Return:

1. Modified file list
2. Test results
3. Key behavior summary
4. Any deviation from plan
5. Known risks or follow-up suggestions
6. Wait for Codex review
