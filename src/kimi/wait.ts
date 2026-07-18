import type { BridgeRuntimeStatus } from './runtime-status.js';
import type { PendingApproval, PendingQuestion } from './types.js';

export type KimiSessionRuntimeStatus = BridgeRuntimeStatus;

export type WaitUntilIdleResult =
  | { status: 'idle' | 'aborted' | 'failed' | 'timeout' | 'running' }
  | { status: 'awaiting_approval'; approvals?: PendingApproval[] }
  | { status: 'awaiting_question'; questions?: PendingQuestion[] };

export interface WaitUntilIdleInput {
  sessionId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  pollStatus: () => Promise<{ status: KimiSessionRuntimeStatus }>;
}

export function deriveWaitResult(input: { status: KimiSessionRuntimeStatus }): WaitUntilIdleResult | null {
  if (input.status === 'running') return null;
  return { status: input.status };
}

export async function waitUntilIdle(input: WaitUntilIdleInput): Promise<WaitUntilIdleResult> {
  const intervalMs = input.pollIntervalMs ?? 500;
  const deadline = Date.now() + input.timeoutMs;

  do {
    const pollStart = Date.now();
    const status = await input.pollStatus();
    const result = deriveWaitResult(status);
    if (result !== null) return result;

    const elapsed = Date.now() - pollStart;
    const remaining = deadline - Date.now();
    const sleepMs = Math.max(0, Math.min(intervalMs - elapsed, remaining));
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  } while (Date.now() < deadline);

  return { status: 'timeout' };
}
