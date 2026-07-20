import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBridgeConfig } from '../src/config.js';

describe('loadBridgeConfig', () => {
  it('uses safe defaults', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'kimi-bridge-test-'));
    vi.stubEnv('HOME', tmpHome);
    try {
      expect(loadBridgeConfig({})).toEqual({
        serverUrl: 'http://127.0.0.1:58627',
        defaultModel: undefined,
        defaultThinking: 'high',
        defaultPermissionMode: 'auto',
        requestTimeoutMs: 30000,
        serverToken: undefined,
        serverTokenSource: 'none',
        envServerToken: undefined,
        autoStart: true,
        kimiCommand: 'kimi',
        preflightCacheMs: 5000,
        kimiCodeHome: undefined,
        stateDir: join(tmpHome, '.codex-kimi-bridge', 'state'),
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('falls back when KIMI_REQUEST_TIMEOUT_MS is malformed or non-positive', () => {
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: 'not-a-number' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '0' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '-100' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '15000' }).requestTimeoutMs).toBe(15000);
  });

  it('parses KIMI_PREFLIGHT_CACHE_MS with safe fallback and allows 0', () => {
    expect(loadBridgeConfig({}).preflightCacheMs).toBe(5000);
    expect(loadBridgeConfig({ KIMI_PREFLIGHT_CACHE_MS: 'not-a-number' }).preflightCacheMs).toBe(5000);
    expect(loadBridgeConfig({ KIMI_PREFLIGHT_CACHE_MS: '-100' }).preflightCacheMs).toBe(5000);
    expect(loadBridgeConfig({ KIMI_PREFLIGHT_CACHE_MS: '0' }).preflightCacheMs).toBe(0);
    expect(loadBridgeConfig({ KIMI_PREFLIGHT_CACHE_MS: '10000' }).preflightCacheMs).toBe(10000);
  });

  it('normalizes a server URL with /api/v1 suffix and trailing slash', () => {
    expect(loadBridgeConfig({ KIMI_SERVER_URL: 'http://localhost:58627/api/v1/' }).serverUrl)
      .toBe('http://localhost:58627');
  });

  it('reads auto-start and command settings', () => {
    expect(loadBridgeConfig({}).autoStart).toBe(true);
    expect(loadBridgeConfig({ KIMI_AUTO_START: 'false' }).autoStart).toBe(false);
    expect(loadBridgeConfig({ KIMI_AUTO_START: '0' }).autoStart).toBe(false);
    expect(loadBridgeConfig({}).kimiCommand).toBe('kimi');
    expect(loadBridgeConfig({ KIMI_COMMAND: '/opt/kimi/bin/kimi' }).kimiCommand).toBe('/opt/kimi/bin/kimi');
    expect(loadBridgeConfig({ KIMI_CODE_HOME: '/custom/home' }).kimiCodeHome).toBe('/custom/home');
  });

  it('uses KIMI_BRIDGE_STATE_DIR or a home-based default', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'kimi-bridge-test-'));
    vi.stubEnv('HOME', tmpHome);
    try {
      expect(loadBridgeConfig({}).stateDir).toBe(join(tmpHome, '.codex-kimi-bridge', 'state'));
      expect(loadBridgeConfig({ KIMI_BRIDGE_STATE_DIR: '/custom/state' }).stateDir).toBe('/custom/state');
    } finally {
      vi.unstubAllEnvs();
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  describe('server token resolution', () => {
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = mkdtempSync(join(tmpdir(), 'kimi-bridge-test-'));
      vi.stubEnv('HOME', tmpHome);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(tmpHome, { recursive: true, force: true });
    });

    it('reads KIMI_SERVER_TOKEN from env', () => {
      vi.stubEnv('KIMI_SERVER_TOKEN', 'env-token');
      const config = loadBridgeConfig(process.env);
      expect(config.serverToken).toBe('env-token');
      expect(config.serverTokenSource).toBe('env');
    });

    it('falls back to ~/.kimi-code/server.token when env is not set', () => {
      mkdirSync(join(tmpHome, '.kimi-code'), { recursive: true });
      writeFileSync(join(tmpHome, '.kimi-code', 'server.token'), 'file-token\n');
      const config = loadBridgeConfig({});
      expect(config.serverToken).toBe('file-token');
      expect(config.serverTokenSource).toBe('home');
    });

    it('returns undefined when env is empty and token file is missing or empty', () => {
      expect(loadBridgeConfig({}).serverToken).toBeUndefined();
      expect(loadBridgeConfig({}).serverTokenSource).toBe('none');
      mkdirSync(join(tmpHome, '.kimi-code'), { recursive: true });
      writeFileSync(join(tmpHome, '.kimi-code', 'server.token'), '   \n');
      expect(loadBridgeConfig({}).serverToken).toBeUndefined();
      expect(loadBridgeConfig({}).serverTokenSource).toBe('none');
    });

    it('prefers env token, then KIMI_CODE_HOME file, then home file', () => {
      const codeHome = mkdtempSync(join(tmpdir(), 'kimi-code-home-test-'));
      writeFileSync(join(codeHome, 'server.token'), 'codehome-token');
      mkdirSync(join(tmpHome, '.kimi-code'), { recursive: true });
      writeFileSync(join(tmpHome, '.kimi-code', 'server.token'), 'home-token');
      vi.stubEnv('KIMI_CODE_HOME', codeHome);

      const fromCodeHome = loadBridgeConfig(process.env);
      expect(fromCodeHome.serverToken).toBe('codehome-token');
      expect(fromCodeHome.serverTokenSource).toBe('kimi_code_home');

      vi.stubEnv('KIMI_SERVER_TOKEN', 'env-token');
      const fromEnv = loadBridgeConfig(process.env);
      expect(fromEnv.serverToken).toBe('env-token');
      expect(fromEnv.serverTokenSource).toBe('env');

      rmSync(codeHome, { recursive: true, force: true });
    });
  });
});
