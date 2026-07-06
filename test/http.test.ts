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
