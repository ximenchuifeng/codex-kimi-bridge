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

  it('falls back when KIMI_REQUEST_TIMEOUT_MS is malformed or non-positive', () => {
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: 'not-a-number' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '0' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '-100' }).requestTimeoutMs).toBe(30000);
    expect(loadBridgeConfig({ KIMI_REQUEST_TIMEOUT_MS: '15000' }).requestTimeoutMs).toBe(15000);
  });
});
