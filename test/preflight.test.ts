import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
import type { KimiHttpClient } from '../src/kimi/http.js';
import { KimiPreflight, type BridgeStatus } from '../src/preflight.js';
import type { BridgeConfig } from '../src/config.js';
import { loadBridgeConfig } from '../src/config.js';

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    serverUrl: 'http://127.0.0.1:58627',
    defaultModel: 'kimi-k2',
    defaultThinking: 'high',
    defaultPermissionMode: 'auto',
    requestTimeoutMs: 30000,
    serverToken: undefined,
    serverTokenSource: 'none',
    autoStart: true,
    kimiCommand: 'kimi',
    preflightCacheMs: 5000,
    ...overrides,
  };
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

type HttpResult = 'ok' | 'error' | Error;

function makeHttp(sequences: { healthz: HttpResult[]; config?: HttpResult[] }) {
  let healthzIndex = 0;
  let configIndex = 0;
  const setServerToken = vi.fn();
  const defaultHealthzError = new KimiNetworkError('unreachable', new Error('ECONNREFUSED'));
  const defaultConfigError = new KimiApiError(40101, 'auth required', 'r');

  return {
    get: vi.fn(async (path: string): Promise<unknown> => {
      if (path === '/healthz') {
        const result = sequences.healthz[healthzIndex++] ?? defaultHealthzError;
        if (result === 'ok') return { status: 'ok' };
        throw result === 'error' ? defaultHealthzError : result;
      }
      if (path === '/config') {
        const seq = sequences.config ?? [defaultConfigError];
        const result = seq[configIndex++] ?? defaultConfigError;
        if (result === 'ok') return { default_model: 'kimi-k2' };
        throw result === 'error' ? defaultConfigError : result;
      }
      throw new Error(`unexpected path: ${path}`);
    }),
    setServerToken,
  } as unknown as KimiHttpClient;
}

function makeTokenAwareHttp(initialToken: string | undefined, validToken: string) {
  let currentToken = initialToken;
  const setServerToken = vi.fn((token?: string) => {
    currentToken = token;
  });
  return {
    get: vi.fn(async (path: string): Promise<unknown> => {
      if (path === '/healthz') return { status: 'ok' };
      if (path === '/config') {
        if (currentToken === validToken) return { default_model: 'kimi-k2' };
        throw new KimiApiError(40101, 'auth required', 'r');
      }
      throw new Error(`unexpected path: ${path}`);
    }),
    setServerToken,
  } as unknown as KimiHttpClient;
}

function makeFakeChildProcess(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as unknown as { unref: () => void }).unref = () => {};
  return child;
}

describe('KimiPreflight', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns ok when healthz and config succeed', async () => {
    const http = makeHttp({ healthz: ['ok'], config: ['ok'] });
    const preflight = new KimiPreflight(makeConfig(), http, { pollIntervalMs: 10 });
    const result = await preflight.ensureReady();
    expect(result.healthzOk).toBe(true);
    expect(result.authOk).toBe(true);
    expect(result.tokenSource).toBe('none');
  });

  it('starts the server when healthz fails and autoStart is true', async () => {
    const http = makeHttp({ healthz: ['error', 'error', 'ok'], config: ['ok'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, { spawn, pollIntervalMs: 10 });

    const promise = preflight.ensureReady();
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.healthzOk).toBe(true);
    expect(spawn).toHaveBeenCalledWith('kimi', ['server', 'run', '--keep-alive'], {
      detached: true,
      stdio: 'ignore',
    });
  });

  it('does not start the server when autoStart is false', async () => {
    const http = makeHttp({ healthz: ['error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: false }), http, { spawn });

    await expect(preflight.ensureReady()).rejects.toThrow(/auto-start disabled|not reachable/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('times out when the server never becomes healthy', async () => {
    const http = makeHttp({ healthz: ['error', 'error', 'error', 'error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, {
      spawn,
      startupTimeoutMs: 100,
      pollIntervalMs: 20,
      now: () => Date.now(),
    });

    const promise = preflight.ensureReady();
    const rejection = expect(promise).rejects.toThrow(/did not respond|timeout|healthz/);
    await vi.advanceTimersByTimeAsync(200);
    await rejection;
    expect(spawn).toHaveBeenCalled();
  });

  it('reloads token and retries once on 401', async () => {
    const http = makeTokenAwareHttp('old', 'new');
    const preflight = new KimiPreflight(makeConfig({ serverToken: 'old', serverTokenSource: 'home' }), http, {
      resolveToken: () => ({ token: 'new', source: 'home' as const }),
      pollIntervalMs: 10,
    });

    const result = await preflight.ensureReady();
    expect(result.authOk).toBe(true);
    expect(http.setServerToken).toHaveBeenCalledWith('new');
  });

  it('throws a friendly auth error when retry still fails', async () => {
    const http = makeTokenAwareHttp('bad', 'valid');
    const preflight = new KimiPreflight(makeConfig({ serverToken: 'bad', serverTokenSource: 'home' }), http, {
      resolveToken: () => ({ token: 'still-bad', source: 'home' as const }),
      pollIntervalMs: 10,
    });

    await expect(preflight.ensureReady()).rejects.toThrow(/token may be invalid|--dangerous-bypass-auth|KIMI_CODE_HOME/);
  });

  it('re-reads token file on 401 using the default resolver', async () => {
    const codeHome = mkdtempSync(join(tmpdir(), 'kimi-bridge-token-reload-'));
    try {
      writeFileSync(join(codeHome, 'server.token'), 'old');

      const config = loadBridgeConfig({ KIMI_CODE_HOME: codeHome });
      expect(config.serverToken).toBe('old');
      expect(config.serverTokenSource).toBe('kimi_code_home');
      expect(config.envServerToken).toBeUndefined();

      writeFileSync(join(codeHome, 'server.token'), 'new');

      const http = makeTokenAwareHttp('old', 'new');
      const preflight = new KimiPreflight(config, http, { pollIntervalMs: 10 });

      const result = await preflight.ensureReady();
      expect(result.authOk).toBe(true);
      expect(result.tokenSource).toBe('kimi_code_home');
      expect(http.setServerToken).toHaveBeenCalledWith('new');
    } finally {
      rmSync(codeHome, { recursive: true, force: true });
    }
  });

  it('getStatus does not auto-start and returns diagnostics', async () => {
    const http = makeHttp({ healthz: ['error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, { spawn });

    const status = await preflight.getStatus();
    expect(status.healthzOk).toBe(false);
    expect(status.authOk).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(status.diagnostics.length).toBeGreaterThan(0);
    expect(status.preflightCacheMs).toBe(5000);
    expect(status.cacheFresh).toBe(false);
  });

  it('getStatus returns ready with webBaseUrl, canOpenWeb and nextActions', async () => {
    const http = makeHttp({ healthz: ['ok'], config: ['ok'] });
    const preflight = new KimiPreflight(makeConfig({ serverToken: 'super-secret-token', serverTokenSource: 'env' }), http, {
      pollIntervalMs: 10,
    });

    const status = await preflight.getStatus();
    expect(status.status).toBe('ready');
    expect(status.webBaseUrl).toBe('http://127.0.0.1:58627/');
    expect(status.canOpenWeb).toBe(true);
    expect(status.nextActions.length).toBeGreaterThan(0);
    expect(status.nextActions.some((a) => a.includes('委托'))).toBe(true);
    expect(JSON.stringify(status)).not.toContain('super-secret-token');
  });

  it('getStatus returns server_unreachable with auto-start hint when autoStart is true', async () => {
    const http = makeHttp({ healthz: ['error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, { spawn, pollIntervalMs: 10 });

    const status = await preflight.getStatus();
    expect(status.status).toBe('server_unreachable');
    expect(status.canOpenWeb).toBe(false);
    expect(status.webBaseUrl).toBe('http://127.0.0.1:58627/');
    expect(status.nextActions.some((a) => a.includes('自动'))).toBe(true);
    expect(status.nextActions.some((a) => a.includes('--keep-alive'))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('getStatus returns server_unreachable with manual start hint when autoStart is false', async () => {
    const http = makeHttp({ healthz: ['error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: false }), http, { spawn });

    const status = await preflight.getStatus();
    expect(status.status).toBe('server_unreachable');
    expect(status.canOpenWeb).toBe(false);
    expect(status.nextActions.some((a) => a.includes('手动启动'))).toBe(true);
    expect(status.nextActions.some((a) => a.includes('KIMI_AUTO_START'))).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('getStatus returns auth_failed with token suggestions and no token leak', async () => {
    const http = makeHttp({ healthz: ['ok'], config: ['error'] });
    const preflight = new KimiPreflight(makeConfig({ serverToken: 'leaked-token', serverTokenSource: 'env' }), http, {
      pollIntervalMs: 10,
    });

    const status = await preflight.getStatus();
    expect(status.status).toBe('auth_failed');
    expect(status.healthzOk).toBe(true);
    expect(status.authOk).toBe(false);
    expect(status.canOpenWeb).toBe(true);
    expect(status.nextActions.some((a) => a.includes('KIMI_SERVER_TOKEN'))).toBe(true);
    expect(status.nextActions.some((a) => a.includes('KIMI_CODE_HOME'))).toBe(true);
    expect(status.nextActions.some((a) => a.includes('--dangerous-bypass-auth'))).toBe(true);
    expect(JSON.stringify(status)).not.toContain('leaked-token');
  });

  it('getStatus does not use or update the success cache', async () => {
    const http = makeHttp({ healthz: ['ok', 'ok', 'ok'], config: ['ok', 'ok', 'ok'] });
    let time = 0;
    const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 5000 }), http, { now: () => time });

    const first = await preflight.ensureReady();
    expect(first.status).toBe('ready');
    expect(http.get).toHaveBeenCalledTimes(2);

    time = 1000;
    const status = await preflight.getStatus();
    expect(status.status).toBe('ready');
    expect(status.cacheFresh).toBe(false);
    expect(http.get).toHaveBeenCalledTimes(4);

    const cached = await preflight.ensureReady();
    expect(cached.cacheFresh).toBe(true);
    expect(cached.status).toBe('ready');
    expect(http.get).toHaveBeenCalledTimes(4);
  });

  describe('commands', () => {
    it('returns empty commands when ready', async () => {
      const http = makeHttp({ healthz: ['ok'], config: ['ok'] });
      const preflight = new KimiPreflight(
        makeConfig({ serverToken: 'secret-token', serverTokenSource: 'env' }),
        http,
        { pollIntervalMs: 10 },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('ready');
      expect(status.commands).toEqual([]);
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });

    it('includes the start command when server is unreachable and autoStart is false', async () => {
      const http = makeHttp({ healthz: ['error'] });
      const spawn = vi.fn(() => makeFakeChildProcess());
      const preflight = new KimiPreflight(
        makeConfig({ autoStart: false, kimiCommand: 'kimi' }),
        http,
        { spawn },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('server_unreachable');
      expect(status.commands).toContain('kimi server start');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('includes the keep-alive command using the configured kimiCommand when server is unreachable and autoStart is true', async () => {
      const http = makeHttp({ healthz: ['error'] });
      const spawn = vi.fn(() => makeFakeChildProcess());
      const preflight = new KimiPreflight(
        makeConfig({ autoStart: true, kimiCommand: 'mykimi' }),
        http,
        { spawn },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('server_unreachable');
      expect(status.commands).toContain('mykimi server run --keep-alive');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('includes a safe token file check command when auth fails', async () => {
      const http = makeHttp({ healthz: ['ok'], config: ['error'] });
      const preflight = new KimiPreflight(
        makeConfig({ serverToken: 'secret-token', serverTokenSource: 'home' }),
        http,
        { pollIntervalMs: 10 },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('auth_failed');
      expect(status.commands?.some((c) => c.includes('server.token'))).toBe(true);
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });

    it('includes a safe env-token hint when auth fails and token source is env', async () => {
      const http = makeHttp({ healthz: ['ok'], config: ['error'] });
      const preflight = new KimiPreflight(
        makeConfig({ serverToken: 'secret-token', serverTokenSource: 'env' }),
        http,
        { pollIntervalMs: 10 },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('auth_failed');
      expect(status.commands?.length).toBeGreaterThan(0);
      expect(status.commands?.some((c) => c.includes('KIMI_SERVER_TOKEN'))).toBe(true);
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });

    it('shell-quotes kimiCommand with spaces in server_unreachable commands', async () => {
      const http = makeHttp({ healthz: ['error'] });
      const spawn = vi.fn(() => makeFakeChildProcess());
      const preflight = new KimiPreflight(
        makeConfig({ autoStart: false, kimiCommand: 'my kimi' }),
        http,
        { spawn },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('server_unreachable');
      expect(status.commands).toContain(`${shellQuote('my kimi')} server start`);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('shell-quotes kimiCommand with single quotes in server_unreachable commands', async () => {
      const http = makeHttp({ healthz: ['error'] });
      const spawn = vi.fn(() => makeFakeChildProcess());
      const preflight = new KimiPreflight(
        makeConfig({ autoStart: true, kimiCommand: "ki'mi" }),
        http,
        { spawn },
      );

      const status = await preflight.getStatus();
      expect(status.status).toBe('server_unreachable');
      expect(status.commands).toContain(`${shellQuote("ki'mi")} server run --keep-alive`);
      expect(spawn).not.toHaveBeenCalled();
    });

    it('shell-quotes kimiCodeHome with spaces and quotes in auth_failed token check', async () => {
      const http = makeHttp({ healthz: ['ok'], config: ['error'] });
      const weirdHome = "/tmp/ki mi'\"dir";
      const preflight = new KimiPreflight(
        makeConfig({
          serverToken: 'secret-token',
          serverTokenSource: 'kimi_code_home',
          kimiCodeHome: weirdHome,
        }),
        http,
        { pollIntervalMs: 10 },
      );

      const status = await preflight.getStatus();
      const expectedPath = join(weirdHome, 'server.token');
      const expectedCheck = `test -f ${shellQuote(expectedPath)} && echo "token file exists" || echo "token file missing"`;
      expect(status.status).toBe('auth_failed');
      expect(status.commands).toContain(expectedCheck);
      expect(JSON.stringify(status)).not.toContain('secret-token');
    });
  });

  describe('success cache', () => {
    it('caches a successful ensureReady result and reuses it within the cache window', async () => {
      const http = makeHttp({ healthz: ['ok'], config: ['ok'] });
      let time = 0;
      const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 5000 }), http, { now: () => time });

      const first = await preflight.ensureReady();
      expect(first.healthzOk).toBe(true);
      expect(first.authOk).toBe(true);
      expect(first.preflightCacheMs).toBe(5000);
      expect(http.get).toHaveBeenCalledTimes(2);

      time = 1000;
      const second = await preflight.ensureReady();
      expect(second.healthzOk).toBe(true);
      expect(second.authOk).toBe(true);
      expect(second.cacheFresh).toBe(true);
      expect(second.cacheAgeMs).toBe(1000);
      expect(second.cachedUntil).toBe(5000);
      expect(http.get).toHaveBeenCalledTimes(2);
    });

    it('re-checks healthz/config after the cache window expires', async () => {
      const http = makeHttp({ healthz: ['ok', 'ok'], config: ['ok', 'ok'] });
      let time = 0;
      const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 100 }), http, { now: () => time });

      await preflight.ensureReady();
      expect(http.get).toHaveBeenCalledTimes(2);

      time = 101;
      await preflight.ensureReady();
      expect(http.get).toHaveBeenCalledTimes(4);
    });

    it('does not cache failed ensureReady results', async () => {
      const http = makeHttp({ healthz: ['error', 'ok'], config: ['ok'] });
      let time = 0;
      const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 5000, autoStart: false }), http, { now: () => time });

      await expect(preflight.ensureReady()).rejects.toThrow(/not reachable|auto-start disabled/);
      expect(http.get).toHaveBeenCalledTimes(1);

      time = 100;
      const result = await preflight.ensureReady();
      expect(result.healthzOk).toBe(true);
      expect(result.authOk).toBe(true);
      expect(http.get).toHaveBeenCalledTimes(3);
    });

    it('caches the successful result after auto-starting the server', async () => {
      const http = makeHttp({ healthz: ['error', 'ok'], config: ['ok'] });
      const spawn = vi.fn(() => makeFakeChildProcess());
      let time = 0;
      const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 5000, autoStart: true }), http, {
        spawn,
        pollIntervalMs: 10,
        now: () => time,
      });

      const promise = preflight.ensureReady();
      await vi.advanceTimersByTimeAsync(50);
      const first = await promise;
      expect(first.healthzOk).toBe(true);
      expect(first.authOk).toBe(true);
      const callsAfterFirst = vi.mocked(http.get).mock.calls.length;

      time = 1000;
      const second = await preflight.ensureReady();
      expect(second.healthzOk).toBe(true);
      expect(second.cacheFresh).toBe(true);
      expect(vi.mocked(http.get).mock.calls.length).toBe(callsAfterFirst);
    });

    it('caches the result after reloading the token on 401', async () => {
      const http = makeTokenAwareHttp('old', 'new');
      let time = 0;
      const preflight = new KimiPreflight(
        makeConfig({ serverToken: 'old', serverTokenSource: 'home', preflightCacheMs: 5000 }),
        http,
        {
          resolveToken: () => ({ token: 'new', source: 'env' as const }),
          now: () => time,
        },
      );

      const first = await preflight.ensureReady();
      expect(first.authOk).toBe(true);
      expect(first.tokenSource).toBe('env');
      const callsAfterFirst = vi.mocked(http.get).mock.calls.length;

      time = 1000;
      const second = await preflight.ensureReady();
      expect(second.authOk).toBe(true);
      expect(second.tokenSource).toBe('env');
      expect(second.cacheFresh).toBe(true);
      expect(vi.mocked(http.get).mock.calls.length).toBe(callsAfterFirst);
    });

    it('getStatus always checks live and does not update the success cache', async () => {
      const http = makeHttp({ healthz: ['ok', 'ok', 'ok'], config: ['ok', 'ok', 'ok'] });
      let time = 0;
      const preflight = new KimiPreflight(makeConfig({ preflightCacheMs: 5000 }), http, { now: () => time });

      await preflight.ensureReady();
      expect(http.get).toHaveBeenCalledTimes(2);

      const status = await preflight.getStatus();
      expect(status.healthzOk).toBe(true);
      expect(status.cacheFresh).toBe(false);
      expect(http.get).toHaveBeenCalledTimes(4);

      time = 1000;
      const cached = await preflight.ensureReady();
      expect(cached.cacheFresh).toBe(true);
      expect(http.get).toHaveBeenCalledTimes(4);
    });
  });
});
