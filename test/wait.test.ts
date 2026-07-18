import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveWaitResult, waitUntilIdle } from '../src/kimi/wait.js';

describe('deriveWaitResult', () => {
  it('returns idle for idle status', () => {
    expect(deriveWaitResult({ status: 'idle' })).toEqual({ status: 'idle' });
  });

  it('returns blocked statuses', () => {
    expect(deriveWaitResult({ status: 'awaiting_approval' })).toEqual({ status: 'awaiting_approval' });
    expect(deriveWaitResult({ status: 'awaiting_question' })).toEqual({ status: 'awaiting_question' });
  });

  it('keeps waiting while running', () => {
    expect(deriveWaitResult({ status: 'running' })).toBeNull();
  });
});

describe('waitUntilIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns idle immediately when the session is already idle', async () => {
    const pollStatus = vi.fn(async () => ({ status: 'idle' as const }));
    const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 5000, pollStatus });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual({ status: 'idle' });
    expect(pollStatus).toHaveBeenCalledTimes(1);
  });

  it('returns aborted as a terminal status', async () => {
    const pollStatus = vi.fn(async () => ({ status: 'aborted' as const }));
    const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 5000, pollStatus });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual({ status: 'aborted' });
    expect(pollStatus).toHaveBeenCalledTimes(1);
  });

  it('returns failed as a terminal status', async () => {
    const pollStatus = vi.fn(async () => ({ status: 'failed' as const }));
    const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 5000, pollStatus });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toEqual({ status: 'failed' });
    expect(pollStatus).toHaveBeenCalledTimes(1);
  });

  it('returns timeout when the session keeps running', async () => {
    const pollStatus = vi.fn(async () => ({ status: 'running' as const }));
    const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 100, pollIntervalMs: 30, pollStatus });

    await vi.advanceTimersByTimeAsync(150);

    await expect(promise).resolves.toEqual({ status: 'timeout' });
    expect(pollStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('respects poll latency so the deadline is not overshot', async () => {
    let polls = 0;
    const pollStatus = vi.fn(async () => {
      polls += 1;
      if (polls === 1) {
        await vi.advanceTimersByTimeAsync(60);
        return { status: 'running' as const };
      }
      return { status: 'idle' as const };
    });

    const promise = waitUntilIdle({ sessionId: 's1', timeoutMs: 250, pollIntervalMs: 100, pollStatus });

    await vi.advanceTimersByTimeAsync(250);

    await expect(promise).resolves.toEqual({ status: 'idle' });
    expect(polls).toBeGreaterThanOrEqual(2);
  });
});
