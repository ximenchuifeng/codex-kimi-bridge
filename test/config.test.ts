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
