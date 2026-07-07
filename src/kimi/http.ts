import { KimiApiError, KimiNetworkError } from '../errors.js';
import type { Envelope } from './types.js';

type FetchLike = typeof fetch;

interface ErrorEnvelope {
  code: number;
  msg: string;
  request_id: string;
  details?: unknown;
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as Record<string, unknown>).code === 'number' &&
    'msg' in value &&
    typeof (value as Record<string, unknown>).msg === 'string' &&
    'request_id' in value &&
    typeof (value as Record<string, unknown>).request_id === 'string'
  );
}

const FRIENDLY_AUTH_MESSAGE =
  'Kimi server requires authentication. Set KIMI_SERVER_TOKEN or start Kimi with --dangerous-bypass-auth for local smoke testing.';

export class KimiHttpClient {
  constructor(
    private readonly serverUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly requestTimeoutMs: number = 30000,
    private serverToken?: string,
  ) {}

  setServerToken(token?: string): void {
    this.serverToken = token;
  }

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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const headers: Record<string, string> = {};
    if (this.serverToken) headers.authorization = `Bearer ${this.serverToken}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method,
        headers: Object.keys(headers).length > 0 ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new KimiNetworkError(`Network error calling ${method} ${path}`, error);
    } finally {
      clearTimeout(timeout);
    }

    let bodyText: string;
    try {
      bodyText = await response.text();
    } catch (error) {
      throw new KimiNetworkError(`Failed to read response body from ${method} ${path}`, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      if (response.status === 401) {
        const requestId = isErrorEnvelope(parsed) ? parsed.request_id : undefined;
        const code = isErrorEnvelope(parsed) ? parsed.code : response.status;
        throw new KimiApiError(code, FRIENDLY_AUTH_MESSAGE, requestId);
      }
      if (isErrorEnvelope(parsed)) {
        throw new KimiApiError(parsed.code, parsed.msg, parsed.request_id, parsed.details);
      }
      throw new KimiApiError(response.status, `HTTP error ${response.status} ${response.statusText}`, undefined);
    }

    const envelope = parsed as Envelope<T> | undefined;
    if (!envelope || typeof envelope.code !== 'number') {
      throw new KimiNetworkError(
        `Failed to parse JSON response from ${method} ${path}`,
        new SyntaxError('Response body is not a Kimi envelope'),
      );
    }
    if (envelope.code !== 0) {
      throw new KimiApiError(envelope.code, envelope.msg, envelope.request_id, envelope.details);
    }
    return envelope.data;
  }
}
