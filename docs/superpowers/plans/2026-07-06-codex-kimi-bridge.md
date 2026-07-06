# Codex Kimi Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Codex plugin and MCP bridge that lets Codex delegate implementation work to Kimi Code, wait for completion, inspect diffs, and continue the review loop.

**Architecture:** The bridge is a TypeScript MCP server. It talks to Kimi's local server over `/api/v1` REST and `/api/v1/ws`, mirroring the protocol used by Kimi Web. Codex remains the coordinator; Kimi executes tasks and may use AgentSwarm internally when `swarm_mode` is enabled.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, `ws`, `zod`, `@modelcontextprotocol/sdk`, Kimi Code local server REST/WebSocket protocol.

## Global Constraints

- Do not implement a direct ACP client in the MVP.
- Codex owns spec, plan, review, verification, and completion decisions.
- Kimi owns implementation execution.
- Use Kimi server REST `/api/v1` and WebSocket `/api/v1/ws`.
- REST responses are envelopes: `{ code, msg, data, request_id }`; non-zero `code` is failure.
- Prompt submission must include `content`, `model`, `thinking`, `permission_mode`, `plan_mode`, and optional `swarm_mode`.
- Default implementation permission mode is `auto`, not `yolo`.
- Do not auto-approve destructive or broad commands.
- Prefer structured outputs that Codex can review without reading a full transcript.

---

## File Structure

- Create `package.json`: package scripts and dependencies.
- Create `tsconfig.json`: TypeScript compiler settings.
- Create `vitest.config.ts`: test config.
- Create `src/index.ts`: MCP server entrypoint.
- Create `src/config.ts`: environment and default config resolution.
- Create `src/kimi/http.ts`: REST client with envelope unwrap.
- Create `src/kimi/types.ts`: Kimi wire and app-facing types.
- Create `src/kimi/ws.ts`: WebSocket event client and wait state machine.
- Create `src/kimi/client.ts`: high-level Kimi operations.
- Create `src/handoff.ts`: handoff and diff aggregation.
- Create `src/tools.ts`: MCP tool schemas and handlers.
- Create `src/errors.ts`: typed bridge errors.
- Create `src/prompt.ts`: delegation prompt builder.
- Create `test/fixtures/fake-kimi-server.ts`: deterministic fake Kimi server for integration tests.
- Create `test/*.test.ts`: unit and integration tests.
- Create `plugins/kimi-delegate/.codex-plugin/plugin.json`: Codex plugin manifest.
- Create `plugins/kimi-delegate/.mcp.json`: MCP server registration.
- Create `plugins/kimi-delegate/skills/kimi-delegate/SKILL.md`: Codex-side workflow instructions.
- Create `README.md`: local setup and smoke test instructions.

---

### Task 1: Project Scaffold And Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Produces: `loadBridgeConfig(env?: NodeJS.ProcessEnv): BridgeConfig`
- Produces: `BridgeConfig { serverUrl: string; defaultModel?: string; defaultThinking: string; defaultPermissionMode: 'manual' | 'auto' | 'yolo'; requestTimeoutMs: number }`

- [ ] **Step 1: Write package metadata**

Create `package.json`:

```json
{
  "name": "codex-kimi-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "codex-kimi-bridge": "dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.17.0",
    "ws": "^8.18.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Write failing config tests**

Create `test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadBridgeConfig } from '../src/config.js';

describe('loadBridgeConfig', () => {
  it('uses safe defaults', () => {
    expect(loadBridgeConfig({})).toEqual({
      serverUrl: 'http://127.0.0.1:58627',
      defaultModel: undefined,
      defaultThinking: 'high',
      defaultPermissionMode: 'auto',
      requestTimeoutMs: 30000,
    });
  });

  it('normalizes a server URL with /api/v1 suffix', () => {
    expect(loadBridgeConfig({ KIMI_SERVER_URL: 'http://localhost:58627/api/v1/' }).serverUrl)
      .toBe('http://localhost:58627');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `pnpm install && pnpm test -- test/config.test.ts`

Expected: fails because `src/config.ts` does not exist.

- [ ] **Step 6: Implement config and minimal entrypoint**

Create `src/config.ts`:

```ts
export interface BridgeConfig {
  serverUrl: string;
  defaultModel?: string;
  defaultThinking: string;
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  requestTimeoutMs: number;
}

function normalizeServerUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const permission = env.KIMI_PERMISSION_MODE;
  const defaultPermissionMode =
    permission === 'manual' || permission === 'auto' || permission === 'yolo'
      ? permission
      : 'auto';

  return {
    serverUrl: normalizeServerUrl(env.KIMI_SERVER_URL ?? 'http://127.0.0.1:58627'),
    defaultModel: env.KIMI_MODEL && env.KIMI_MODEL.trim().length > 0 ? env.KIMI_MODEL : undefined,
    defaultThinking: env.KIMI_THINKING && env.KIMI_THINKING.trim().length > 0 ? env.KIMI_THINKING : 'high',
    defaultPermissionMode,
    requestTimeoutMs: Number.parseInt(env.KIMI_REQUEST_TIMEOUT_MS ?? '30000', 10),
  };
}
```

Create `src/index.ts`:

```ts
import { loadBridgeConfig } from './config.js';

export async function main(): Promise<void> {
  loadBridgeConfig();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 7: Verify**

Run: `pnpm test -- test/config.test.ts && pnpm typecheck`

Expected: all tests pass and typecheck succeeds.

- [ ] **Step 8: Commit**

Run:

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts src/index.ts src/config.ts test/config.test.ts
git commit -m "chore: scaffold codex kimi bridge"
```

---

### Task 2: Kimi REST Client

**Files:**
- Create: `src/errors.ts`
- Create: `src/kimi/types.ts`
- Create: `src/kimi/http.ts`
- Create: `test/http.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig`
- Produces: `KimiHttpClient`
- Produces: `KimiApiError`
- Produces: `Envelope<T> { code: number; msg: string; data: T; request_id: string; details?: unknown }`

- [ ] **Step 1: Write failing HTTP tests**

Create `test/http.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { KimiApiError } from '../src/errors.js';
import { KimiHttpClient } from '../src/kimi/http.js';

describe('KimiHttpClient', () => {
  it('unwraps successful envelopes', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 0,
      msg: 'ok',
      data: { status: 'ok' },
      request_id: 'req_1',
    })));
    const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl);
    await expect(client.get('/healthz')).resolves.toEqual({ status: 'ok' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:58627/api/v1/healthz',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('throws on non-zero envelope code', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 40101,
      msg: 'auth required',
      data: {},
      request_id: 'req_2',
    })));
    const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl);
    await expect(client.get('/sessions')).rejects.toBeInstanceOf(KimiApiError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/http.test.ts`

Expected: fails because HTTP client files do not exist.

- [ ] **Step 3: Implement errors and types**

Create `src/errors.ts`:

```ts
export class KimiApiError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'KimiApiError';
  }
}

export class KimiNetworkError extends Error {
  constructor(message: string, readonly cause: unknown) {
    super(message);
    this.name = 'KimiNetworkError';
  }
}
```

Create `src/kimi/types.ts`:

```ts
export interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

export type PermissionMode = 'manual' | 'auto' | 'yolo';

export interface WireSession {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  metadata: { cwd: string; [key: string]: unknown };
  agent_config: Record<string, unknown>;
  last_seq: number;
}

export interface PromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
}

export interface SessionStatus {
  status: WireSession['status'];
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

- [ ] **Step 4: Implement HTTP client**

Create `src/kimi/http.ts`:

```ts
import { KimiApiError, KimiNetworkError } from '../errors.js';
import type { Envelope } from './types.js';

type FetchLike = typeof fetch;

export class KimiHttpClient {
  constructor(
    private readonly serverUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.serverUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new KimiNetworkError(`Network error calling ${method} ${path}`, error);
    }

    const envelope = (await response.json()) as Envelope<T>;
    if (envelope.code !== 0) {
      throw new KimiApiError(envelope.code, envelope.msg, envelope.request_id, envelope.details);
    }
    return envelope.data;
  }
}
```

- [ ] **Step 5: Verify**

Run: `pnpm test -- test/http.test.ts && pnpm typecheck`

Expected: all tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/errors.ts src/kimi/types.ts src/kimi/http.ts test/http.test.ts
git commit -m "feat: add kimi rest client"
```

---

### Task 3: Prompt Builder And High-Level Kimi Client

**Files:**
- Create: `src/prompt.ts`
- Create: `src/kimi/client.ts`
- Create: `test/prompt.test.ts`
- Create: `test/client.test.ts`

**Interfaces:**
- Consumes: `KimiHttpClient`
- Produces: `buildDelegationPrompt(input: DelegationPromptInput): string`
- Produces: `KimiClient.createSession(input)`
- Produces: `KimiClient.submitPrompt(sessionId, input)`
- Produces: `KimiClient.getStatus(sessionId)`

- [ ] **Step 1: Write prompt tests**

Create `test/prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../src/prompt.js';

describe('buildDelegationPrompt', () => {
  it('includes Codex/Kimi roles and handoff contract', () => {
    const prompt = buildDelegationPrompt({
      task: 'Add a health check endpoint.',
      acceptanceCriteria: ['GET /health returns ok'],
      plan: ['Add route', 'Add test'],
      swarmSuggestions: ['API route', 'test coverage'],
    });

    expect(prompt).toContain('Codex is the coordinator and reviewer');
    expect(prompt).toContain('Add a health check endpoint.');
    expect(prompt).toContain('GET /health returns ok');
    expect(prompt).toContain('If the work has independent parts, use AgentSwarm');
    expect(prompt).toContain('files changed');
    expect(prompt).toContain('tests run and results');
  });
});
```

- [ ] **Step 2: Write client tests with a fake HTTP object**

Create `test/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { KimiClient } from '../src/kimi/client.js';

describe('KimiClient', () => {
  it('creates a session with cwd metadata', async () => {
    const http = { post: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'Task', agent_config: {}, last_seq: 0 })), get: vi.fn() };
    const client = new KimiClient(http);
    await expect(client.createSession({ cwd: '/repo', title: 'Task' })).resolves.toMatchObject({ id: 's1' });
    expect(http.post).toHaveBeenCalledWith('/sessions', { title: 'Task', metadata: { cwd: '/repo' } });
  });

  it('submits prompts with required runtime fields', async () => {
    const http = { post: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })), get: vi.fn() };
    const client = new KimiClient(http);
    await client.submitPrompt('s1', {
      content: 'hello',
      model: 'kimi-k2',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      swarmMode: true,
    });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1/prompts', {
      content: [{ type: 'text', text: 'hello' }],
      model: 'kimi-k2',
      thinking: 'high',
      permission_mode: 'auto',
      plan_mode: false,
      swarm_mode: true,
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test -- test/prompt.test.ts test/client.test.ts`

Expected: fails because prompt and high-level client are missing.

- [ ] **Step 4: Implement prompt builder**

Create `src/prompt.ts`:

```ts
export interface DelegationPromptInput {
  task: string;
  acceptanceCriteria: readonly string[];
  plan: readonly string[];
  swarmSuggestions?: readonly string[];
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '- none' : items.map((item) => `- ${item}`).join('\n');
}

export function buildDelegationPrompt(input: DelegationPromptInput): string {
  const swarm =
    input.swarmSuggestions && input.swarmSuggestions.length > 0
      ? list(input.swarmSuggestions)
      : '- Use your judgment; avoid AgentSwarm for small or tightly coupled changes.';

  return `You are the implementation worker. Codex is the coordinator and reviewer.

Implement the requested work in this repository. Do not change unrelated files.

Task:
${input.task}

Acceptance criteria:
${list(input.acceptanceCriteria)}

Plan from Codex:
${list(input.plan)}

Parallelization:
If the work has independent parts, use AgentSwarm. Suggested split:
${swarm}

When complete, return a handoff with:
- files changed
- implementation summary
- commands run
- tests run and results
- risks or incomplete items
- anything requiring Codex review
`;
}
```

- [ ] **Step 5: Implement high-level Kimi client**

Create `src/kimi/client.ts`:

```ts
import type { KimiHttpClient } from './http.js';
import type { PermissionMode, PromptSubmitResult, SessionStatus, WireSession } from './types.js';

interface HttpPort {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CreateSessionInput {
  cwd: string;
  title?: string;
}

export interface SubmitPromptInput {
  content: string;
  model: string;
  thinking: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode?: boolean;
}

export class KimiClient {
  constructor(private readonly http: KimiHttpClient | HttpPort) {}

  createSession(input: CreateSessionInput): Promise<WireSession> {
    return this.http.post('/sessions', {
      ...(input.title ? { title: input.title } : {}),
      metadata: { cwd: input.cwd },
    });
  }

  getStatus(sessionId: string): Promise<SessionStatus> {
    return this.http.get(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  submitPrompt(sessionId: string, input: SubmitPromptInput): Promise<PromptSubmitResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      content: [{ type: 'text', text: input.content }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_mode: input.planMode,
      ...(input.swarmMode === undefined ? {} : { swarm_mode: input.swarmMode }),
    });
  }
}
```

- [ ] **Step 6: Verify**

Run: `pnpm test -- test/prompt.test.ts test/client.test.ts && pnpm typecheck`

Expected: all tests pass and typecheck succeeds.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/prompt.ts src/kimi/client.ts test/prompt.test.ts test/client.test.ts
git commit -m "feat: add kimi delegation prompt and client"
```

---

### Task 4: WebSocket Session Watcher

**Files:**
- Create: `src/kimi/ws.ts`
- Create: `test/ws.test.ts`

**Interfaces:**
- Produces: `KimiEventWatcher`
- Produces: `waitUntilIdle(input: WaitUntilIdleInput): Promise<WaitUntilIdleResult>`
- Result statuses: `'idle' | 'awaiting_approval' | 'awaiting_question' | 'aborted' | 'timeout'`

- [ ] **Step 1: Write state-machine tests without real sockets**

Create `test/ws.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deriveWaitResult } from '../src/kimi/ws.js';

describe('deriveWaitResult', () => {
  it('returns idle for idle status', () => {
    expect(deriveWaitResult({ status: 'idle' })).toEqual({ status: 'idle' });
  });

  it('returns blocked statuses', () => {
    expect(deriveWaitResult({ status: 'awaiting_approval' })).toEqual({ status: 'awaiting_approval' });
    expect(deriveWaitResult({ status: 'awaiting_question' })).toEqual({ status: 'awaiting_question' });
  });

  it('keeps waiting while running', () => {
    expect(deriveWaitResult({ status: 'running' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/ws.test.ts`

Expected: fails because `src/kimi/ws.ts` does not exist.

- [ ] **Step 3: Implement watcher state helpers and socket skeleton**

Create `src/kimi/ws.ts`:

```ts
import WebSocket from 'ws';

export type KimiSessionRuntimeStatus = 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';

export interface WaitUntilIdleResult {
  status: 'idle' | 'awaiting_approval' | 'awaiting_question' | 'aborted' | 'timeout';
}

export interface WaitUntilIdleInput {
  sessionId: string;
  timeoutMs: number;
  pollStatus: () => Promise<{ status: KimiSessionRuntimeStatus }>;
}

export function deriveWaitResult(input: { status: KimiSessionRuntimeStatus }): WaitUntilIdleResult | null {
  if (input.status === 'running') return null;
  return { status: input.status };
}

export class KimiEventWatcher {
  constructor(private readonly serverUrl: string) {}

  wsUrl(clientId: string): string {
    const url = new URL(`${this.serverUrl}/api/v1/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('client_id', clientId);
    return url.toString();
  }

  createSocket(clientId: string): WebSocket {
    return new WebSocket(this.wsUrl(clientId));
  }
}

export async function waitUntilIdle(input: WaitUntilIdleInput): Promise<WaitUntilIdleResult> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const status = await input.pollStatus();
    const result = deriveWaitResult(status);
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { status: 'timeout' };
}
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- test/ws.test.ts && pnpm typecheck`

Expected: all tests pass and typecheck succeeds.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/kimi/ws.ts test/ws.test.ts
git commit -m "feat: add kimi session wait state"
```

---

### Task 5: Handoff And Diff Aggregation

**Files:**
- Create: `src/handoff.ts`
- Create: `test/handoff.test.ts`
- Modify: `src/kimi/client.ts`

**Interfaces:**
- Produces: `KimiHandoff`
- Produces: `buildHandoff(input: BuildHandoffInput): KimiHandoff`
- Adds: `KimiClient.listMessages(sessionId)`
- Adds: `KimiClient.getGitStatus(sessionId)`
- Adds: `KimiClient.getFileDiff(sessionId, path)`

- [ ] **Step 1: Write handoff tests**

Create `test/handoff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildHandoff } from '../src/handoff.js';

describe('buildHandoff', () => {
  it('extracts changed files and final assistant text', () => {
    const handoff = buildHandoff({
      messages: [
        { role: 'assistant', content: 'Working...' },
        { role: 'assistant', content: 'files changed\n- src/a.ts\ncommands run\n- pnpm test' },
      ],
      gitStatus: { entries: { 'src/a.ts': 'M' }, additions: 10, deletions: 2 },
      diffs: [{ path: 'src/a.ts', diff: '@@ fake diff' }],
      waitStatus: 'idle',
    });

    expect(handoff.finalMessage).toContain('files changed');
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.diffs).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/handoff.test.ts`

Expected: fails because `src/handoff.ts` does not exist.

- [ ] **Step 3: Implement handoff builder**

Create `src/handoff.ts`:

```ts
export interface HandoffMessage {
  role: string;
  content: string;
}

export interface GitStatusSummary {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface BuildHandoffInput {
  messages: readonly HandoffMessage[];
  gitStatus: GitStatusSummary;
  diffs: readonly FileDiff[];
  waitStatus: string;
}

export interface KimiHandoff {
  status: string;
  finalMessage: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}

export function buildHandoff(input: BuildHandoffInput): KimiHandoff {
  const finalAssistant = [...input.messages].reverse().find((message) => message.role === 'assistant');
  return {
    status: input.waitStatus,
    finalMessage: finalAssistant?.content ?? '',
    changedFiles: Object.keys(input.gitStatus.entries).sort(),
    additions: input.gitStatus.additions,
    deletions: input.gitStatus.deletions,
    diffs: [...input.diffs],
  };
}
```

- [ ] **Step 4: Extend KimiClient**

Modify `src/kimi/client.ts` to add:

```ts
export interface WireMessage {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
}

export interface GitStatusResult {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

function messageText(message: WireMessage): string {
  return message.content.map((part) => part.text ?? '').join('');
}
```

Add methods inside `KimiClient`:

```ts
  async listMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    const page = await this.http.get<{ items: WireMessage[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
    return page.items.map((message) => ({ role: message.role, content: messageText(message) }));
  }

  getGitStatus(sessionId: string): Promise<GitStatusResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:git_status`, {});
  }

  getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string }> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:diff`, { path });
  }
```

- [ ] **Step 5: Verify**

Run: `pnpm test -- test/handoff.test.ts test/client.test.ts && pnpm typecheck`

Expected: all tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/handoff.ts src/kimi/client.ts test/handoff.test.ts
git commit -m "feat: add kimi handoff aggregation"
```

---

### Task 6: MCP Tool Handlers

**Files:**
- Create: `src/tools.ts`
- Modify: `src/index.ts`
- Create: `test/tools.test.ts`

**Interfaces:**
- Produces: `createToolHandlers(deps): ToolHandlers`
- Tool handlers:
  - `kimi_delegate_task`
  - `kimi_wait_until_idle`
  - `kimi_get_handoff`
  - `kimi_continue_task`
  - `kimi_get_diff`
  - `kimi_abort`

- [ ] **Step 1: Write handler tests**

Create `test/tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createToolHandlers } from '../src/tools.js';

describe('tool handlers', () => {
  it('delegates a task by creating a session and submitting a prompt', async () => {
    const kimi = {
      createSession: vi.fn(async () => ({ id: 's1' })),
      submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
    };
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: {
        serverUrl: 'http://127.0.0.1:58627',
        defaultModel: 'kimi-k2',
        defaultThinking: 'high',
        defaultPermissionMode: 'auto',
        requestTimeoutMs: 30000,
      },
    });

    await expect(handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    })).resolves.toMatchObject({ sessionId: 's1', promptId: 'p1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/tools.test.ts`

Expected: fails because `src/tools.ts` does not exist.

- [ ] **Step 3: Implement tool handlers**

Create `src/tools.ts`:

```ts
import type { BridgeConfig } from './config.js';
import { buildDelegationPrompt } from './prompt.js';
import type { KimiClient } from './kimi/client.js';

export interface ToolDeps {
  kimi: KimiClient;
  config: BridgeConfig;
}

export interface DelegateTaskInput {
  cwd: string;
  task: string;
  acceptanceCriteria: string[];
  plan: string[];
  swarmMode?: boolean;
  sessionId?: string;
  model?: string;
  thinking?: string;
}

export function createToolHandlers(deps: ToolDeps) {
  return {
    async kimi_delegate_task(input: DelegateTaskInput) {
      const session = input.sessionId
        ? { id: input.sessionId }
        : await deps.kimi.createSession({ cwd: input.cwd, title: input.task.slice(0, 80) });
      const prompt = buildDelegationPrompt({
        task: input.task,
        acceptanceCriteria: input.acceptanceCriteria,
        plan: input.plan,
        swarmSuggestions: input.swarmMode ? input.plan : undefined,
      });
      const result = await deps.kimi.submitPrompt(session.id, {
        content: prompt,
        model: input.model ?? deps.config.defaultModel ?? 'default',
        thinking: input.thinking ?? deps.config.defaultThinking,
        permissionMode: deps.config.defaultPermissionMode,
        planMode: false,
        swarmMode: input.swarmMode,
      });
      return { sessionId: session.id, promptId: result.prompt_id, status: result.status };
    },
  };
}
```

- [ ] **Step 4: Wire MCP entrypoint**

Modify `src/index.ts` so it creates the HTTP client, Kimi client, and MCP server. Use this shape:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadBridgeConfig } from './config.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiClient } from './kimi/client.js';
import { createToolHandlers } from './tools.js';

export async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const kimi = new KimiClient(new KimiHttpClient(config.serverUrl));
  const handlers = createToolHandlers({ kimi, config });
  const server = new McpServer({ name: 'codex-kimi-bridge', version: '0.1.0' });

  server.tool(
    'kimi_delegate_task',
    {
      cwd: z.string(),
      task: z.string(),
      acceptanceCriteria: z.array(z.string()),
      plan: z.array(z.string()),
      swarmMode: z.boolean().optional(),
      sessionId: z.string().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_delegate_task(input), null, 2) }],
    }),
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Verify**

Run: `pnpm test -- test/tools.test.ts && pnpm typecheck`

Expected: tests pass and typecheck succeeds.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat: expose kimi delegation mcp tool"
```

---

### Task 7: Fake Kimi Server Integration Test

**Files:**
- Create: `test/fixtures/fake-kimi-server.ts`
- Create: `test/integration.test.ts`

**Interfaces:**
- Produces: `startFakeKimiServer(): Promise<FakeKimiServer>`
- `FakeKimiServer` exposes `url` and `close()`

- [ ] **Step 1: Write integration test**

Create `test/integration.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { KimiHttpClient } from '../src/kimi/http.js';
import { KimiClient } from '../src/kimi/client.js';
import { startFakeKimiServer, type FakeKimiServer } from './fixtures/fake-kimi-server.js';

let server: FakeKimiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('bridge integration', () => {
  it('creates a session and submits a prompt to a Kimi-compatible server', async () => {
    server = await startFakeKimiServer();
    const kimi = new KimiClient(new KimiHttpClient(server.url));
    const session = await kimi.createSession({ cwd: '/repo', title: 'test' });
    const prompt = await kimi.submitPrompt(session.id, {
      content: 'hello',
      model: 'default',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      swarmMode: true,
    });

    expect(session.id).toBe('s1');
    expect(prompt.prompt_id).toBe('p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- test/integration.test.ts`

Expected: fails because fake server is missing.

- [ ] **Step 3: Implement fake server**

Create `test/fixtures/fake-kimi-server.ts`:

```ts
import { createServer, type Server } from 'node:http';

export interface FakeKimiServer {
  url: string;
  close(): Promise<void>;
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'req_fake' });
}

export async function startFakeKimiServer(): Promise<FakeKimiServer> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      res.end(envelope({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1/prompts') {
      res.end(envelope({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      return;
    }
    res.end(JSON.stringify({ code: 40401, msg: `not found: ${req.method} ${req.url}`, data: {}, request_id: 'req_404' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake server did not bind to a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
```

- [ ] **Step 4: Verify**

Run: `pnpm test -- test/integration.test.ts && pnpm typecheck`

Expected: integration test passes and typecheck succeeds.

- [ ] **Step 5: Commit**

Run:

```bash
git add test/fixtures/fake-kimi-server.ts test/integration.test.ts
git commit -m "test: add fake kimi server integration coverage"
```

---

### Task 8: Codex Plugin Packaging

**Files:**
- Create: `plugins/kimi-delegate/.codex-plugin/plugin.json`
- Create: `plugins/kimi-delegate/.mcp.json`
- Create: `plugins/kimi-delegate/skills/kimi-delegate/SKILL.md`
- Create: `README.md`

**Interfaces:**
- Produces: installable local Codex plugin folder.
- Produces: skill instructions that tell Codex to delegate execution to Kimi.

- [ ] **Step 1: Create plugin manifest**

Create `plugins/kimi-delegate/.codex-plugin/plugin.json`:

```json
{
  "name": "kimi-delegate",
  "version": "0.1.0",
  "description": "Delegate implementation tasks from Codex to Kimi Code through a local MCP bridge.",
  "mcp": {
    "config": "../.mcp.json"
  },
  "skills": {
    "path": "skills"
  }
}
```

- [ ] **Step 2: Create MCP config**

Create `plugins/kimi-delegate/.mcp.json`:

```json
{
  "mcpServers": {
    "kimi-delegate": {
      "command": "node",
      "args": [
        "../../dist/index.js"
      ],
      "env": {
        "KIMI_SERVER_URL": "http://127.0.0.1:58627",
        "KIMI_PERMISSION_MODE": "auto",
        "KIMI_THINKING": "high"
      }
    }
  }
}
```

- [ ] **Step 3: Create skill instructions**

Create `plugins/kimi-delegate/skills/kimi-delegate/SKILL.md`:

```md
---
name: kimi-delegate
description: Use when Codex should coordinate a software task but delegate implementation execution to Kimi Code.
---

# Kimi Delegate

Use this skill when the user wants Codex to act as planner, reviewer, and coordinator while Kimi Code performs implementation.

## Rules

- Codex owns spec, plan, review, verification, and final completion decisions.
- Kimi owns implementation execution.
- Do not implement code directly in Codex when the user has asked for Kimi execution.
- Use `kimi_delegate_task` to send implementation tasks to Kimi.
- Use `kimi_get_handoff` and `kimi_get_diff` before reviewing Kimi's work.
- Use `kimi_continue_task` for review feedback until acceptance criteria pass.
- Enable swarm mode only when the task has independent work items.
- Do not auto-approve destructive commands.

## Delegation Prompt

Every task sent to Kimi must include:

- task
- acceptance criteria
- Codex plan
- swarm split suggestion when useful
- handoff requirements

## Review Loop

1. Prepare or update the spec and implementation plan.
2. Delegate to Kimi.
3. Wait for Kimi to finish or block.
4. Gather handoff and diff.
5. Review against acceptance criteria.
6. Send precise follow-up feedback to Kimi if review fails.
7. Independently verify before declaring completion.
```

- [ ] **Step 4: Create README**

Create `README.md`:

```md
# Codex Kimi Bridge

Local Codex plugin and MCP bridge for delegating implementation tasks to Kimi Code while Codex remains the planner and reviewer.

## Development

```bash
pnpm install
pnpm test
pnpm build
```

## Kimi Server

Start Kimi server before using the bridge:

```bash
kimi server run --foreground
```

Default bridge target:

```text
http://127.0.0.1:58627
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
```

- [ ] **Step 5: Verify**

Run: `pnpm test && pnpm build`

Expected: all tests pass and build succeeds.

- [ ] **Step 6: Commit**

Run:

```bash
git add plugins/kimi-delegate/.codex-plugin/plugin.json plugins/kimi-delegate/.mcp.json plugins/kimi-delegate/skills/kimi-delegate/SKILL.md README.md
git commit -m "feat: package kimi delegate codex plugin"
```

---

## Final Verification

- [ ] Run: `pnpm test`
- [ ] Run: `pnpm typecheck`
- [ ] Run: `pnpm build`
- [ ] Start Kimi server: `kimi server run --foreground`
- [ ] In another terminal, run MCP server smoke test: `node dist/index.js`
- [ ] Configure Codex to load `plugins/kimi-delegate`
- [ ] Delegate a tiny change to a disposable repo
- [ ] Confirm Codex receives session id, prompt id, handoff, and diff

## Execution Rule For This Project

Implementation execution belongs to Kimi. Codex should use this plan to prepare delegation prompts, review Kimi's returned changes, and request follow-up work. Codex should not implement the bridge inline unless the user explicitly changes that rule.
