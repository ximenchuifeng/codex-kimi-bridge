import { describe, expect, it } from 'vitest';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
import { runToolHandler } from '../src/index.js';

describe('runToolHandler', () => {
  it('returns successful results as MCP text content', async () => {
    const result = await runToolHandler(async () => ({ ok: true }));
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    });
  });

  it('returns structured MCP errors for KimiApiError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiApiError(40001, 'bad request', 'req_123', { field: 'name' });
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'bad request',
      code: 40001,
      requestId: 'req_123',
      details: { field: 'name' },
    });
  });

  it('returns structured MCP errors for KimiNetworkError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiNetworkError('connection refused', new Error('ECONNREFUSED'));
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('connection refused');
    expect(parsed.code).toBe('NETWORK');
  });

  it('returns structured MCP errors for unexpected errors', async () => {
    const result = await runToolHandler(async () => {
      throw new Error('boom');
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('boom');
    expect(parsed.code).toBe('UNKNOWN');
  });
});
