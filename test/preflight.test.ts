import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
import type { KimiHttpClient } from '../src/kimi/http.js';
import { KimiPreflight, type BridgeStatus } from '../src/preflight.js';
import type { BridgeConfig } from '../src/config.js';

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
    ...overrides,
  };
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

  it('getStatus does not auto-start and returns diagnostics', async () => {
    const http = makeHttp({ healthz: ['error'] });
    const spawn = vi.fn(() => makeFakeChildProcess());
    const preflight = new KimiPreflight(makeConfig({ autoStart: true }), http, { spawn });

    const status = await preflight.getStatus();
    expect(status.healthzOk).toBe(false);
    expect(status.authOk).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(status.diagnostics.length).toBeGreaterThan(0);
  });
});
