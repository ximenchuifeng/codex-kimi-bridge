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
