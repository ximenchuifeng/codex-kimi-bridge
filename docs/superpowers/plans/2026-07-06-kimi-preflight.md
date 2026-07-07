# Kimi Server Preflight / Auto-Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Codex -> bridge -> Kimi Code flow seamless by automatically preflighting the Kimi server (health check, auto-start, token refresh) before every tool call and exposing a status tool.

**Architecture:** Add a `KimiPreflight` class that performs healthz, optional `kimi server run --keep-alive`, and `/config` auth verification. Wrap existing tool handlers to call `preflight.ensureReady()`. Expose `kimi_bridge_status` via a read-only `preflight.getStatus()`. Keep token resolution and startup diagnostics explicit but never leak token values.

**Tech Stack:** TypeScript, Vitest, Node `child_process.spawn`, existing `KimiHttpClient`.

## Global Constraints

- Do not change Kimi Code server.
- Do not change Codex plugin installation mechanism.
- Do not commit any real token.
- Do not use `--dangerous-bypass-auth` as a default.
- Do not let Codex or users manually create smoke files to bypass Kimi execution.
- All new behavior must be covered by failing-first tests.

---

### Task 1: Extend bridge configuration

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `BridgeConfig` gains `autoStart: boolean`, `kimiCommand: string`, `kimiCodeHome?: string`, `serverTokenSource: 'env' | 'kimi_code_home' | 'home' | 'none'`.
- Produces: exported `resolveServerToken(envToken, kimiCodeHome?) -> { token?: string; source: TokenSource }`.

- [ ] **Step 1: Write the failing config tests**

Add tests in `test/config.test.ts`:

```typescript
it('defaults auto-start to true', () => {
  const config = loadBridgeConfig({});
  expect(config.autoStart).toBe(true);
});

it('disables auto-start when KIMI_AUTO_START=false', () => {
  expect(loadBridgeConfig({ KIMI_AUTO_START: 'false' }).autoStart).toBe(false);
  expect(loadBridgeConfig({ KIMI_AUTO_START: '0' }).autoStart).toBe(false);
});

it('uses default kimi command and allows override', () => {
  expect(loadBridgeConfig({}).kimiCommand).toBe('kimi');
  expect(loadBridgeConfig({ KIMI_COMMAND: '/opt/kimi/bin/kimi' }).kimiCommand).toBe('/opt/kimi/bin/kimi');
});

it('prefers env token, then KIMI_CODE_HOME file, then home file', () => {
  // setup tmpHome with .kimi-code/server.token = 'home-token'
  const codeHome = mkdtempSync(...);
  mkdirSync(join(codeHome, '.kimi-code'), { recursive: true });
  writeFileSync(join(codeHome, '.kimi-code', 'server.token'), 'home-file-token');
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('KIMI_CODE_HOME', codeHome);
  expect(loadBridgeConfig({}).serverToken).toBe('home-file-token');
  writeFileSync(join(codeHome, 'server.token'), 'codehome-token');
  expect(loadBridgeConfig({}).serverToken).toBe('codehome-token');
  vi.stubEnv('KIMI_SERVER_TOKEN', 'env-token');
  expect(loadBridgeConfig(process.env).serverToken).toBe('env-token');
});
```

- [ ] **Step 2: Run tests and confirm they fail**

```bash
pnpm test --run test/config.test.ts
# Expected: property missing / undefined
```

- [ ] **Step 3: Implement config changes**

Update `src/config.ts`:

```typescript
export type TokenSource = 'env' | 'kimi_code_home' | 'home' | 'none';

export interface BridgeConfig {
  serverUrl: string;
  defaultModel?: string;
  defaultThinking: string;
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  requestTimeoutMs: number;
  serverToken?: string;
  serverTokenSource: TokenSource;
  autoStart: boolean;
  kimiCommand: string;
  kimiCodeHome?: string;
}

export function resolveServerToken(
  envToken: string | undefined,
  kimiCodeHome: string | undefined,
  homeDir: string = homedir(),
): { token?: string; source: TokenSource } {
  const trimmedEnv = envToken?.trim();
  if (trimmedEnv && trimmedEnv.length > 0) {
    return { token: trimmedEnv, source: 'env' };
  }
  const candidates = [
    kimiCodeHome ? { path: join(kimiCodeHome, 'server.token'), source: 'kimi_code_home' as const },
    { path: join(homeDir, '.kimi-code', 'server.token'), source: 'home' as const },
  ];
  for (const candidate of candidates) {
    if (!candidate.path) continue;
    try {
      const fileToken = readFileSync(candidate.path, 'utf-8').trim();
      if (fileToken.length > 0) return { token: fileToken, source: candidate.source };
    } catch {
      // continue
    }
  }
  return { source: 'none' };
}
```

Update `loadBridgeConfig` to populate new fields:

```typescript
const { token, source } = resolveServerToken(env.KIMI_SERVER_TOKEN, env.KIMI_CODE_HOME);
return {
  ...existing,
  serverToken: token,
  serverTokenSource: source,
  autoStart: !(env.KIMI_AUTO_START === 'false' || env.KIMI_AUTO_START === '0'),
  kimiCommand: env.KIMI_COMMAND && env.KIMI_COMMAND.trim().length > 0 ? env.KIMI_COMMAND.trim() : 'kimi',
  kimiCodeHome: env.KIMI_CODE_HOME && env.KIMI_CODE_HOME.trim().length > 0 ? env.KIMI_CODE_HOME.trim() : undefined,
};
```

- [ ] **Step 4: Run tests and confirm they pass**

```bash
pnpm test --run test/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add auto-start, command, KIMI_CODE_HOME, token source"
```

---

### Task 2: Mutable server token on KimiHttpClient

**Files:**
- Modify: `src/kimi/http.ts`

**Interfaces:**
- Produces: `KimiHttpClient.setServerToken(token?: string)`.

- [ ] **Step 1: Write failing test**

In `test/http.test.ts`:

```typescript
it('can update the bearer token after construction', async () => {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 0, msg: 'ok', data: {}, request_id: 'r' })));
  const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, 'old');
  client.setServerToken('new');
  await client.get('/healthz');
  expect(fetchImpl).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer new' }) }),
  );
});
```

- [ ] **Step 2: Implement minimal change**

```typescript
private serverToken?: string; // remove readonly

setServerToken(token?: string): void {
  this.serverToken = token;
}
```

- [ ] **Step 3: Run tests**

```bash
pnpm test --run test/http.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/kimi/http.ts test/http.test.ts
git commit -m "feat(http): allow updating bearer token after construction"
```

---

### Task 3: Implement preflight module

**Files:**
- Create: `src/preflight.ts`
- Create: `test/preflight.test.ts`

**Interfaces:**
- Produces: `BridgeStatus` interface and `KimiPreflight` class.
- Consumes: `BridgeConfig`, `KimiHttpClient`, Node `spawn`.

- [ ] **Step 1: Write failing preflight tests**

```typescript
describe('KimiPreflight', () => {
  it('returns ok when healthz and config succeed', async () => {
    const http = makeFakeHttp({ healthz: true, config: true });
    const preflight = new KimiPreflight(makeConfig(), http);
    const result = await preflight.ensureReady();
    expect(result.healthzOk).toBe(true);
    expect(result.authOk).toBe(true);
  });

  it('starts the server when healthz fails and autoStart is true', async () => {
    const http = makeFakeHttp({ healthzSequence: ['fail', 'fail', 'ok'], config: true });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, { spawn });
    await preflight.ensureReady();
    expect(spawn).toHaveBeenCalledWith('kimi', ['server', 'run', '--keep-alive'], expect.any(Object));
  });

  it('does not start the server when autoStart is false', async () => {
    const http = makeFakeHttp({ healthz: false });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: false }), http, { spawn });
    await expect(preflight.ensureReady()).rejects.toThrow(/auto-start disabled/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reloads token and retries once on 401', async () => {
    const http = makeFakeHttp({ healthz: true, configSequence: [401, 200] });
    const config = makeConfig({ serverToken: 'old', serverTokenSource: 'home' });
    const preflight = new KimiPreflight(config, http, { resolveToken: () => ({ token: 'new', source: 'home' }) });
    await preflight.ensureReady();
    expect(http.setServerToken).toHaveBeenCalledWith('new');
  });

  it('throws friendly auth error when retry fails', async () => {
    const http = makeFakeHttp({ healthz: true, configSequence: [401, 401] });
    const preflight = new KimiPreflight(makeConfig({ serverToken: 'bad' }), http);
    await expect(preflight.ensureReady()).rejects.toThrow(/token may be invalid/);
  });
});
```

- [ ] **Step 2: Implement preflight.ts**

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import type { BridgeConfig, TokenSource } from './config.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiApiError } from './errors.js';

export interface BridgeStatus {
  serverUrl: string;
  healthzOk: boolean;
  authOk: boolean;
  tokenSource: TokenSource;
  autoStart: boolean;
  kimiCommand: string;
  diagnostics: string[];
}

export interface PreflightOptions {
  spawn?: (command: string, args: readonly string[], options: { detached: boolean; stdio: 'ignore' }) => ChildProcess;
  resolveToken?: (config: BridgeConfig) => { token?: string; source: TokenSource };
  now?: () => number;
}

export class KimiPreflight {
  constructor(
    private readonly config: BridgeConfig,
    private readonly http: KimiHttpClient,
    private readonly options: PreflightOptions = {},
  ) {}

  async ensureReady(): Promise<BridgeStatus> {
    let status = await this.checkOnce();
    if (!status.healthzOk) {
      if (!this.config.autoStart) {
        throw new Error(`Kimi server is not reachable at ${this.config.serverUrl}. Set KIMI_AUTO_START=true or start the server manually.`);
      }
      await this.startServer();
      status = await this.waitForHealthz();
    }
    if (!status.authOk) {
      status = await this.verifyAuthWithRetry();
    }
    return status;
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.checkOnce();
  }

  private async checkOnce(): Promise<BridgeStatus> {
    const diagnostics: string[] = [];
    let healthzOk = false;
    try {
      await this.http.get('/healthz');
      healthzOk = true;
    } catch (error) {
      diagnostics.push(`healthz failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let authOk = false;
    if (healthzOk) {
      try {
        await this.http.get('/config');
        authOk = true;
      } catch (error) {
        diagnostics.push(`auth check failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      serverUrl: this.config.serverUrl,
      healthzOk,
      authOk,
      tokenSource: this.config.serverTokenSource,
      autoStart: this.config.autoStart,
      kimiCommand: this.config.kimiCommand,
      diagnostics,
    };
  }

  private async startServer(): Promise<void> {
    const spawnImpl = this.options.spawn ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnImpl(this.config.kimiCommand, ['server', 'run', '--keep-alive'], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', (error) => reject(new Error(`Failed to start Kimi server: ${error.message}`)));
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`Kimi server exited with code ${code}. Is '${this.config.kimiCommand}' installed and on PATH?`));
        }
      });
      // Give the spawn a tick to fail immediately; otherwise we resolve and rely on healthz polling.
      setImmediate(() => {
        if (!child.killed) {
          child.unref();
          resolve();
        }
      });
    });
  }

  private async waitForHealthz(): Promise<BridgeStatus> {
    const deadline = (this.options.now ?? Date.now)() + 30000;
    let lastStatus: BridgeStatus | undefined;
    while (Date.now() < deadline) {
      lastStatus = await this.checkOnce();
      if (lastStatus.healthzOk) {
        if (!lastStatus.authOk) return lastStatus;
        return lastStatus;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const diagnostics = lastStatus?.diagnostics ?? ['Kimi server did not become ready in time.'];
    throw new Error(`Kimi server did not respond to healthz within 30 seconds.\n${diagnostics.join('\n')}`);
  }

  private async verifyAuthWithRetry(): Promise<BridgeStatus> {
    const first = await this.checkOnce();
    if (first.authOk) return first;
    const { token, source } = (this.options.resolveToken ?? resolveServerTokenForConfig)(this.config);
    if (token && token !== this.config.serverToken) {
      this.http.setServerToken(token);
      (this.config as WritableBridgeConfig).serverToken = token;
      (this.config as WritableBridgeConfig).serverTokenSource = source;
      const second = await this.checkOnce();
      if (second.authOk) return second;
    }
    throw new Error(
      `Kimi server authentication failed. The token may be invalid, or the server is using a different KIMI_CODE_HOME. ` +
        `For local smoke testing only, start Kimi with --dangerous-bypass-auth.`,
    );
  }
}
```

- [ ] **Step 3: Run tests and confirm they pass**

```bash
pnpm test --run test/preflight.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/preflight.ts test/preflight.test.ts
git commit -m "feat(preflight): add healthz, auto-start, auth retry"
```

---

### Task 4: Wire preflight into tools and add status tool

**Files:**
- Modify: `src/tools.ts`
- Modify: `src/index.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `KimiPreflight` from Task 3.
- Produces: `ToolDeps` gains `preflight: KimiPreflight`. `ToolHandlers` gains `kimi_bridge_status`.

- [ ] **Step 1: Write failing tests**

In `test/tools.test.ts` add a preflight mock helper and assert each listed handler calls `ensureReady`. Add a status test:

```typescript
function makePreflight(overrides: Partial<import('../src/preflight.js').BridgeStatus> = {}) {
  return {
    ensureReady: vi.fn(async () => ({ healthzOk: true, authOk: true, ...overrides })),
    getStatus: vi.fn(async () => ({ healthzOk: true, authOk: true, tokenSource: 'home', ...overrides })),
  } as unknown as import('../src/preflight.js').KimiPreflight;
}

it('preflights before delegating a task', async () => {
  const preflight = makePreflight();
  const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });
  await handlers.kimi_delegate_task({ cwd: '/repo', task: 'x', acceptanceCriteria: [], plan: [] });
  expect(preflight.ensureReady).toHaveBeenCalled();
});

it('kimi_bridge_status returns status without leaking token', async () => {
  const preflight = makePreflight({ serverUrl: 'http://127.0.0.1:58627', autoStart: true, kimiCommand: 'kimi' });
  const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig({ serverToken: 'secret' }), preflight });
  const status = await handlers.kimi_bridge_status();
  expect(status.tokenSource).toBe('home');
  expect(JSON.stringify(status)).not.toContain('secret');
});
```

- [ ] **Step 2: Implement tool wiring**

Update `src/tools.ts`:

```typescript
import type { KimiPreflight, BridgeStatus } from './preflight.js';

export interface ToolDeps {
  kimi: KimiClient;
  config: BridgeConfig;
  preflight: KimiPreflight;
}

export interface ToolHandlers {
  ...existing,
  kimi_bridge_status: () => Promise<BridgeStatus>;
}

function withPreflight<T extends unknown[], R>(
  preflight: KimiPreflight,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    await preflight.ensureReady();
    return fn(...args);
  };
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  const handlers: ToolHandlers = {
    async kimi_bridge_status() {
      return deps.preflight.getStatus();
    },
    async kimi_delegate_task(input) { ... },
    ...
  };
  return {
    ...handlers,
    kimi_delegate_task: withPreflight(deps.preflight, handlers.kimi_delegate_task),
    kimi_wait_until_idle: withPreflight(deps.preflight, handlers.kimi_wait_until_idle),
    kimi_get_handoff: withPreflight(deps.preflight, handlers.kimi_get_handoff),
    kimi_continue_task: withPreflight(deps.preflight, handlers.kimi_continue_task),
    kimi_get_diff: withPreflight(deps.preflight, handlers.kimi_get_diff),
    kimi_abort: withPreflight(deps.preflight, handlers.kimi_abort),
  };
}
```

- [ ] **Step 3: Update index.ts**

```typescript
import { KimiPreflight } from './preflight.js';

const config = loadBridgeConfig();
const http = new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs, config.serverToken);
const preflight = new KimiPreflight(config, http);
const kimi = new KimiClient(http);
const handlers = createToolHandlers({ kimi, config, preflight });

server.tool('kimi_bridge_status', {}, async () => runToolHandler(() => handlers.kimi_bridge_status()));
```

- [ ] **Step 4: Run tests**

```bash
pnpm test --run
```

- [ ] **Step 5: Commit**

```bash
git add src/tools.ts src/index.ts test/tools.test.ts
git commit -m "feat(tools): wire preflight and add kimi_bridge_status"
```

---

### Task 5: Update plugin configuration and README

**Files:**
- Modify: `plugins/kimi-delegate/.mcp.json`
- Modify: `README.md`

- [ ] **Step 1: Update .mcp.json**

```json
"env": {
  "KIMI_SERVER_URL": "http://127.0.0.1:58627",
  "KIMI_PERMISSION_MODE": "auto",
  "KIMI_THINKING": "high",
  "KIMI_AUTO_START": "true",
  "KIMI_COMMAND": "kimi",
  "KIMI_CODE_HOME": "",
  "KIMI_SERVER_TOKEN": ""
}
```

- [ ] **Step 2: Update README**

Add a "Recommended seamless usage" section covering `kimi server install` + `kimi server start`, bridge auto-start, no manual token copy, and `KIMI_CODE_HOME` synchronization.

- [ ] **Step 3: Validate plugin**

```bash
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

- [ ] **Step 4: Commit**

```bash
git add plugins/kimi-delegate/.mcp.json README.md
git commit -m "docs: document seamless usage and update plugin env"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

- [ ] **Step 2: Report results**

Return modified files, test results, any plan deviations, and known risks.
