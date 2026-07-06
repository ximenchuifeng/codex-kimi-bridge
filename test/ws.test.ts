import { describe, expect, it } from 'vitest';
import { deriveWaitResult } from '../src/kimi/ws.js';

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
