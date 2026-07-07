import { describe, expect, it, vi } from 'vitest';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
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

  it('throws KimiApiError on non-2xx HTTP responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }));
    const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl);
    await expect(client.get('/sessions')).rejects.toMatchObject({
      name: 'KimiApiError',
      code: 502,
    });
  });

  it('preserves envelope details on non-2xx HTTP responses', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 40001,
      msg: 'bad request',
      request_id: 'req_bad',
      details: { field: 'name' },
    }), { status: 400, statusText: 'Bad Request' }));
    const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl);
    await expect(client.get('/sessions')).rejects.toEqual(expect.objectContaining({
      name: 'KimiApiError',
      code: 40001,
      message: 'bad request',
      requestId: 'req_bad',
      details: { field: 'name' },
    }));
  });

  it('throws KimiNetworkError on JSON parse failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json'));
    const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl);
    await expect(client.get('/sessions')).rejects.toBeInstanceOf(KimiNetworkError);
  });

  describe('authentication', () => {
    it('sends Authorization: Bearer when a server token is provided', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {},
        request_id: 'req_auth',
      })));
      const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, 'my-token');
      await client.get('/healthz');
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://127.0.0.1:58627/api/v1/healthz',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer my-token' }),
        }),
      );
    });

    it('sends Authorization without content-type for bodyless requests', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {},
        request_id: 'req_auth',
      })));
      const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, 'my-token');
      await client.get('/healthz');
      const headers = ((fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1]).headers;
      expect(headers.authorization).toBe('Bearer my-token');
      expect(headers['content-type']).toBeUndefined();
    });

    it('sends both Authorization and content-type for JSON body requests', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {},
        request_id: 'req_auth',
      })));
      const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, 'my-token');
      await client.post('/sessions', { cwd: '/repo' });
      const headers = ((fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1]).headers;
      expect(headers.authorization).toBe('Bearer my-token');
      expect(headers['content-type']).toBe('application/json');
    });

    it('returns a Codex-friendly error on 401 Unauthorized', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        code: 40101,
        msg: 'auth required',
        request_id: 'req_401',
      }), { status: 401, statusText: 'Unauthorized' }));
      const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, undefined);
      await expect(client.get('/config')).rejects.toEqual(expect.objectContaining({
        name: 'KimiApiError',
        code: 40101,
        message: expect.stringContaining('Kimi server requires authentication'),
        requestId: 'req_401',
      }));
    });

    it('can update the bearer token after construction', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: {},
        request_id: 'req_update',
      })));
      const client = new KimiHttpClient('http://127.0.0.1:58627', fetchImpl, 30000, 'old-token');
      client.setServerToken('new-token');
      await client.get('/healthz');
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://127.0.0.1:58627/api/v1/healthz',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer new-token' }),
        }),
      );
    });
  });
});
