import WebSocket from 'ws';

export type KimiSessionRuntimeStatus = 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';

export interface WaitUntilIdleResult {
  status: 'idle' | 'awaiting_approval' | 'awaiting_question' | 'aborted' | 'timeout';
}

export interface WaitUntilIdleInput {
  sessionId: string;
  timeoutMs: number;
  pollStatus: () => Promise<{ status: KimiSessionRuntimeStatus }>;
}

export function deriveWaitResult(input: { status: KimiSessionRuntimeStatus }): WaitUntilIdleResult | null {
  if (input.status === 'running') return null;
  return { status: input.status };
}

export class KimiEventWatcher {
  constructor(private readonly serverUrl: string) {}

  wsUrl(clientId: string): string {
    const url = new URL(`${this.serverUrl}/api/v1/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('client_id', clientId);
    return url.toString();
  }

  createSocket(clientId: string): WebSocket {
    return new WebSocket(this.wsUrl(clientId));
  }
}

export async function waitUntilIdle(input: WaitUntilIdleInput): Promise<WaitUntilIdleResult> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const status = await input.pollStatus();
    const result = deriveWaitResult(status);
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { status: 'timeout' };
}
