# Codex Kimi Bridge Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the reviewed bridge implementation so it loads as a valid Codex plugin and works against real Kimi server routes/configuration.

**Architecture:** Keep the current TypeScript MCP bridge. Make focused corrections to plugin packaging, model resolution, Kimi route mapping, and blocked wait results. Do not rewrite the bridge or implement ACP/WebSocket in this pass.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, `@modelcontextprotocol/sdk`, `zod`, Kimi Code local server REST protocol, Codex plugin manifest validation.

## Global Constraints

- Do not implement a direct ACP client in this fix pass.
- Do not implement full WebSocket support in this fix pass.
- Codex owns spec, plan, review, verification, and completion decisions.
- Kimi owns implementation execution.
- Default implementation permission mode remains `auto`, not `yolo`.
- Do not auto-approve destructive or broad commands.
- Tests must reflect real Kimi server routes, not only fake-server conveniences.
- Plugin validation must pass with `/Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py`.

---

## File Structure

- Modify `plugins/kimi-delegate/.codex-plugin/plugin.json`: valid Codex plugin manifest.
- Modify `plugins/kimi-delegate/.mcp.json`: add or document model fallback env as needed.
- Modify `src/config.ts`: keep env config, do not force model here.
- Modify `src/kimi/types.ts`: add Kimi config, approval, and question wire types.
- Modify `src/kimi/client.ts`: add server config/default model lookup, approval/question list methods, correct abort route.
- Modify `src/tools.ts`: resolve model asynchronously from input/env/server config; return blocked details.
- Modify `test/fixtures/fake-kimi-server.ts`: emulate real Kimi routes for config, abort, approvals, questions.
- Modify `test/client.test.ts`: cover default config/model and abort route.
- Modify `test/tools.test.ts`: cover missing model and blocked wait details.
- Modify `test/integration.test.ts`: cover real-route fake server behavior.
- Add `test/plugin.test.ts`: runs plugin validator.
- Modify `README.md`: document `KIMI_MODEL` and server-config fallback.

---

### Task 1: Fix Plugin Manifest Validation

**Files:**
- Modify: `plugins/kimi-delegate/.codex-plugin/plugin.json`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Produces: a plugin manifest accepted by `validate_plugin.py`.
- Produces: `test/plugin.test.ts` that fails if the manifest regresses.

- [ ] **Step 1: Write plugin validation test**

Create `test/plugin.test.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Codex plugin manifest', () => {
  it('passes local plugin validation', () => {
    expect(() => {
      execFileSync(
        'python3',
        [
          '/Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py',
          'plugins/kimi-delegate',
        ],
        { stdio: 'pipe' },
      );
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/plugin.test.ts`

Expected: FAIL with validation errors for unsupported `mcp`, missing `author`, invalid `skills`, and missing `interface`.

- [ ] **Step 3: Replace plugin manifest with valid shape**

Update `plugins/kimi-delegate/.codex-plugin/plugin.json` to:

```json
{
  "name": "kimi-delegate",
  "version": "0.1.0",
  "description": "Delegate implementation tasks from Codex to Kimi Code through a local MCP bridge.",
  "author": {
    "name": "Local"
  },
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Kimi Delegate",
    "shortDescription": "Delegate Codex implementation tasks to Kimi Code.",
    "longDescription": "A local bridge that lets Codex coordinate, review, and continue implementation tasks executed by Kimi Code.",
    "developerName": "Local",
    "category": "Productivity",
    "capabilities": ["Interactive", "Write"]
  }
}
```

- [ ] **Step 4: Verify plugin validation**

Run:

```bash
pnpm test -- test/plugin.test.ts
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected: both pass.

- [ ] **Step 5: Commit**

Run:

```bash
git add plugins/kimi-delegate/.codex-plugin/plugin.json test/plugin.test.ts
git commit -m "fix: make kimi delegate plugin manifest valid"
```

---

### Task 2: Add Server Config And Default Model Resolution

**Files:**
- Modify: `src/kimi/types.ts`
- Modify: `src/kimi/client.ts`
- Modify: `src/tools.ts`
- Modify: `test/client.test.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/fixtures/fake-kimi-server.ts`

**Interfaces:**
- Produces: `KimiClient.getConfig(): Promise<KimiServerConfig>`
- Produces: `KimiClient.resolveDefaultModel(): Promise<string | undefined>`
- Produces: tool model resolution order: input model -> `BridgeConfig.defaultModel` -> Kimi server `default_model`.

- [ ] **Step 1: Add failing client test for server config**

Append to `test/client.test.ts`:

```ts
  it('reads the default model from server config', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async () => ({ default_model: 'kimi-k2' })) as HttpPort['get'],
    };
    const client = new KimiClient(http);
    await expect(client.resolveDefaultModel()).resolves.toBe('kimi-k2');
    expect(http.get).toHaveBeenCalledWith('/config');
  });
```

- [ ] **Step 2: Add failing tool test for model fallback**

Append to `test/tools.test.ts`:

```ts
  it('falls back to Kimi server default_model when KIMI_MODEL is unset', async () => {
    const kimi = makeKimi({
      resolveDefaultModel: vi.fn(async () => 'kimi-k2'),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ defaultModel: undefined }),
    });

    await handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
    });

    expect(kimi.submitPrompt).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ model: 'kimi-k2' }),
    );
  });
```

Update the existing “fails fast when no model is configured” test so the fake Kimi client returns no server default:

```ts
const kimi = makeKimi({
  resolveDefaultModel: vi.fn(async () => undefined),
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- test/client.test.ts test/tools.test.ts`

Expected: FAIL because `resolveDefaultModel` and async tool model resolution do not exist.

- [ ] **Step 4: Add config type**

Modify `src/kimi/types.ts` and add:

```ts
export interface KimiServerConfig {
  default_model?: string;
}
```

- [ ] **Step 5: Implement KimiClient config lookup**

Modify `src/kimi/client.ts`:

```ts
import type { KimiServerConfig, PermissionMode, PromptSubmitResult, SessionStatus, WireSession } from './types.js';
```

Add methods inside `KimiClient`:

```ts
  getConfig(): Promise<KimiServerConfig> {
    return this.http.get('/config');
  }

  async resolveDefaultModel(): Promise<string | undefined> {
    const config = await this.getConfig();
    const model = config.default_model;
    return model && model.trim().length > 0 ? model : undefined;
  }
```

- [ ] **Step 6: Make tool model resolution async**

Modify `src/tools.ts`:

```ts
async function resolveModel(
  kimi: KimiClient,
  inputModel: string | undefined,
  config: BridgeConfig,
): Promise<string> {
  const model = inputModel ?? config.defaultModel ?? await kimi.resolveDefaultModel();
  if (!model) {
    throw new Error('No model specified. Pass model in the MCP call, set KIMI_MODEL, or configure default_model in Kimi server.');
  }
  return model;
}
```

Update both submit calls:

```ts
model: await resolveModel(deps.kimi, input.model, deps.config),
```

- [ ] **Step 7: Update fake server config route**

In `test/fixtures/fake-kimi-server.ts`, add before the 404:

```ts
    if (req.method === 'GET' && req.url === '/api/v1/config') {
      res.end(envelope({ default_model: 'kimi-k2' }));
      return;
    }
```

- [ ] **Step 8: Verify**

Run: `pnpm test -- test/client.test.ts test/tools.test.ts test/integration.test.ts && pnpm typecheck`

Expected: all pass.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/kimi/types.ts src/kimi/client.ts src/tools.ts test/client.test.ts test/tools.test.ts test/fixtures/fake-kimi-server.ts
git commit -m "fix: resolve default model from kimi server config"
```

---

### Task 3: Correct Abort Route

**Files:**
- Modify: `src/kimi/client.ts`
- Modify: `test/client.test.ts`
- Modify: `test/fixtures/fake-kimi-server.ts`
- Modify: `test/integration.test.ts`

**Interfaces:**
- Produces: `KimiClient.abortSession(sessionId): Promise<{ aborted: boolean }>`
- Uses route: `POST /sessions/{id}:abort`

- [ ] **Step 1: Update failing abort test to real route**

Modify the abort test in `test/client.test.ts`:

```ts
  it('aborts a session with the real Kimi action suffix route', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ aborted: true })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await expect(client.abortSession('s1')).resolves.toEqual({ aborted: true });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1:abort');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/client.test.ts`

Expected: FAIL because current code calls `/sessions/s1/abort`.

- [ ] **Step 3: Fix abort implementation**

Modify `src/kimi/client.ts`:

```ts
  abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}:abort`);
  }
```

- [ ] **Step 4: Update fake server**

In `test/fixtures/fake-kimi-server.ts`, add:

```ts
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1:abort') {
      res.end(envelope({ aborted: true }));
      return;
    }
```

- [ ] **Step 5: Add integration assertion**

Append inside the integration test after diff assertion:

```ts
    await expect(kimi.abortSession(session.id)).resolves.toEqual({ aborted: true });
```

- [ ] **Step 6: Verify**

Run: `pnpm test -- test/client.test.ts test/integration.test.ts test/tools.test.ts && pnpm typecheck`

Expected: all pass.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/kimi/client.ts test/client.test.ts test/fixtures/fake-kimi-server.ts test/integration.test.ts
git commit -m "fix: use real kimi session abort route"
```

---

### Task 4: Surface Pending Approval And Question Details

**Files:**
- Modify: `src/kimi/types.ts`
- Modify: `src/kimi/client.ts`
- Modify: `src/kimi/wait.ts`
- Modify: `src/tools.ts`
- Modify: `test/client.test.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/fixtures/fake-kimi-server.ts`

**Interfaces:**
- Produces: `KimiClient.listPendingApprovals(sessionId): Promise<PendingApproval[]>`
- Produces: `KimiClient.listPendingQuestions(sessionId): Promise<PendingQuestion[]>`
- Produces wait result:
  - `{ status: 'awaiting_approval'; approvals: PendingApproval[] }`
  - `{ status: 'awaiting_question'; questions: PendingQuestion[] }`

- [ ] **Step 1: Add failing client tests for pending lists**

Append to `test/client.test.ts`:

```ts
  it('lists pending approvals and questions', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async (path: string) => {
        if (path.includes('/approvals')) return { items: [{ approval_id: 'a1', tool_name: 'Bash' }] };
        if (path.includes('/questions')) return { items: [{ question_id: 'q1', questions: [] }] };
        return {};
      }) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.listPendingApprovals('s1')).resolves.toEqual([{ approval_id: 'a1', tool_name: 'Bash' }]);
    await expect(client.listPendingQuestions('s1')).resolves.toEqual([{ question_id: 'q1', questions: [] }]);

    expect(http.get).toHaveBeenCalledWith('/sessions/s1/approvals', { status: 'pending' });
    expect(http.get).toHaveBeenCalledWith('/sessions/s1/questions', { status: 'pending' });
  });
```

- [ ] **Step 2: Add failing tool tests for blocked details**

Append to `test/tools.test.ts`:

```ts
  it('returns pending approvals when Kimi waits for approval', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_approval' })),
      listPendingApprovals: vi.fn(async () => [{ approval_id: 'a1', tool_name: 'Bash' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({
      status: 'awaiting_approval',
      approvals: [{ approval_id: 'a1', tool_name: 'Bash' }],
    });
  });

  it('returns pending questions when Kimi waits for a question', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_question' })),
      listPendingQuestions: vi.fn(async () => [{ question_id: 'q1', questions: [] }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({
      status: 'awaiting_question',
      questions: [{ question_id: 'q1', questions: [] }],
    });
  });
```

Update `makeKimi` to include:

```ts
resolveDefaultModel: vi.fn(async () => 'kimi-k2') as unknown as KimiClient['resolveDefaultModel'],
listPendingApprovals: vi.fn(async () => []) as unknown as KimiClient['listPendingApprovals'],
listPendingQuestions: vi.fn(async () => []) as unknown as KimiClient['listPendingQuestions'],
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- test/client.test.ts test/tools.test.ts`

Expected: FAIL because pending list methods and blocked detail handling do not exist.

- [ ] **Step 4: Add pending types**

Modify `src/kimi/types.ts`:

```ts
export interface PendingApproval {
  approval_id: string;
  [key: string]: unknown;
}

export interface PendingQuestion {
  question_id: string;
  [key: string]: unknown;
}
```

- [ ] **Step 5: Implement KimiClient pending list methods**

Modify imports in `src/kimi/client.ts`:

```ts
import type { KimiServerConfig, PendingApproval, PendingQuestion, PermissionMode, PromptSubmitResult, SessionStatus, WireSession } from './types.js';
```

Add methods:

```ts
  async listPendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    const page = await this.http.get<{ items: PendingApproval[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/approvals`,
      { status: 'pending' },
    );
    return page.items;
  }

  async listPendingQuestions(sessionId: string): Promise<PendingQuestion[]> {
    const page = await this.http.get<{ items: PendingQuestion[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/questions`,
      { status: 'pending' },
    );
    return page.items;
  }
```

- [ ] **Step 6: Extend wait result types**

Modify `src/kimi/wait.ts`:

```ts
import type { PendingApproval, PendingQuestion } from './types.js';

export type WaitUntilIdleResult =
  | { status: 'idle' | 'aborted' | 'timeout' }
  | { status: 'awaiting_approval'; approvals?: PendingApproval[] }
  | { status: 'awaiting_question'; questions?: PendingQuestion[] };
```

Keep `deriveWaitResult` returning status-only; enrichment happens in tools.

- [ ] **Step 7: Enrich blocked statuses in tool handler**

Modify `kimi_wait_until_idle` in `src/tools.ts`:

```ts
    async kimi_wait_until_idle(input: WaitUntilIdleInput) {
      const result = await waitUntilIdle({
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs ?? deps.config.requestTimeoutMs,
        pollStatus: () => deps.kimi.getStatus(input.sessionId),
      });
      if (result.status === 'awaiting_approval') {
        return {
          status: result.status,
          approvals: await deps.kimi.listPendingApprovals(input.sessionId),
        };
      }
      if (result.status === 'awaiting_question') {
        return {
          status: result.status,
          questions: await deps.kimi.listPendingQuestions(input.sessionId),
        };
      }
      return result;
    },
```

Update `ToolHandlers.kimi_wait_until_idle` return type to `Promise<WaitUntilIdleResult>`.

- [ ] **Step 8: Update fake server pending routes**

In `test/fixtures/fake-kimi-server.ts`, add:

```ts
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/approvals?status=pending') {
      res.end(envelope({ items: [{ approval_id: 'a1', tool_name: 'Bash' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/questions?status=pending') {
      res.end(envelope({ items: [{ question_id: 'q1', questions: [] }] }));
      return;
    }
```

- [ ] **Step 9: Verify**

Run: `pnpm test -- test/client.test.ts test/tools.test.ts && pnpm typecheck`

Expected: all pass.

- [ ] **Step 10: Commit**

Run:

```bash
git add src/kimi/types.ts src/kimi/client.ts src/kimi/wait.ts src/tools.ts test/client.test.ts test/tools.test.ts test/fixtures/fake-kimi-server.ts
git commit -m "fix: surface kimi blocked approval and question details"
```

---

### Task 5: Documentation And Final Verification

**Files:**
- Modify: `README.md`
- Modify: `plugins/kimi-delegate/.mcp.json`

**Interfaces:**
- Produces: docs explaining model resolution and verification commands.
- Keeps `.mcp.json` usable with env-based model override.

- [ ] **Step 1: Update README model documentation**

Add this section to `README.md`:

```md
## Model Resolution

The bridge resolves the Kimi model in this order:

1. `model` passed to the MCP tool call
2. `KIMI_MODEL` environment variable
3. Kimi server `default_model` from `/api/v1/config`

If none are available, the MCP tool returns a structured error. For predictable local use, set:

```bash
export KIMI_MODEL=<your-kimi-model>
```
```

- [ ] **Step 2: Add optional model comment-equivalent in `.mcp.json`**

JSON cannot contain comments. Add an empty default only if you want the plugin to force a model. Otherwise leave `.mcp.json` without `KIMI_MODEL` so server config fallback is exercised.

Preferred `.mcp.json` env:

```json
{
  "KIMI_SERVER_URL": "http://127.0.0.1:58627",
  "KIMI_PERMISSION_MODE": "auto",
  "KIMI_THINKING": "high"
}
```

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
git status --short
```

Expected:

- tests pass
- typecheck passes
- build passes
- plugin validation passes
- only intended files are modified before final commit

- [ ] **Step 4: Commit**

Run:

```bash
git add README.md plugins/kimi-delegate/.mcp.json
git commit -m "docs: document kimi bridge model resolution"
```

---

## Final Handoff Required From Kimi

When complete, return:

- commit hashes created
- files changed
- exact validation command output summary
- whether plugin validation passes
- whether `pnpm test`, `pnpm typecheck`, and `pnpm build` pass
- any deviation from this plan
- any remaining risk or follow-up recommendation

