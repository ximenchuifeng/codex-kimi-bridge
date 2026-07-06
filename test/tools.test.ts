import { describe, expect, it, vi } from 'vitest';
import { createToolHandlers } from '../src/tools.js';
import type { KimiClient } from '../src/kimi/client.js';

function makeKimi(overrides: Record<string, unknown> = {}): KimiClient {
  return {
    createSession: vi.fn(async () => ({ id: 's1' })) as unknown as KimiClient['createSession'],
    submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })) as unknown as KimiClient['submitPrompt'],
    getStatus: vi.fn(async () => ({ status: 'idle' })) as unknown as KimiClient['getStatus'],
    listMessages: vi.fn(async () => []) as unknown as KimiClient['listMessages'],
    getGitStatus: vi.fn(async () => ({ entries: {}, additions: 0, deletions: 0 })) as unknown as KimiClient['getGitStatus'],
    getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '' })) as unknown as KimiClient['getFileDiff'],
    abortSession: vi.fn(async () => undefined) as unknown as KimiClient['abortSession'],
    resolveDefaultModel: vi.fn(async () => 'kimi-k2') as unknown as KimiClient['resolveDefaultModel'],
    listPendingApprovals: vi.fn(async () => []) as unknown as KimiClient['listPendingApprovals'],
    listPendingQuestions: vi.fn(async () => []) as unknown as KimiClient['listPendingQuestions'],
    ...overrides,
  } as KimiClient;
}

function makeConfig(overrides: Partial<import('../src/config.js').BridgeConfig> = {}) {
  return {
    serverUrl: 'http://127.0.0.1:58627',
    defaultModel: 'kimi-k2',
    defaultThinking: 'high',
    defaultPermissionMode: 'auto' as const,
    requestTimeoutMs: 30000,
    ...overrides,
  };
}

describe('tool handlers', () => {
  it('delegates a task by creating a session and submitting a prompt', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig() });

    await expect(handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    })).resolves.toMatchObject({ sessionId: 's1', promptId: 'p1' });
  });

  it('waits until idle using the configured default timeout', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ status: 'idle' }),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 1100 }) });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({ status: 'idle' });
    expect(kimi.getStatus).toHaveBeenCalledWith('s1');
  });

  it('returns timeout when the session does not become idle', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'running' })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 50 }) });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({ status: 'timeout' });
  });

  it('aggregates a handoff from messages, git status, and diffs', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => [
        { role: 'assistant', content: 'Working...' },
        { role: 'assistant', content: 'files changed\n- src/a.ts' },
      ]),
      getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 10, deletions: 2 })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: `@@ diff for ${path}` })),
    });
    const handlers = createToolHandlers({ kimi, config: makeConfig() });

    const handoff = await handlers.kimi_get_handoff({ sessionId: 's1' });

    expect(handoff.status).toBe('idle');
    expect(handoff.finalMessage).toContain('files changed');
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.diffs).toEqual([{ path: 'src/a.ts', diff: '@@ diff for src/a.ts' }]);
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'src/a.ts');
  });

  it('continues a task by submitting a follow-up prompt', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig() });

    const result = await handlers.kimi_continue_task({
      sessionId: 's1',
      task: 'fix the lint errors',
      acceptanceCriteria: ['lint passes'],
      plan: ['run lint --fix'],
    });

    expect(result).toMatchObject({ sessionId: 's1', promptId: 'p1' });
    expect(kimi.submitPrompt).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        content: expect.stringContaining('follow-up'),
        model: 'kimi-k2',
      }),
    );
  });

  it('returns a file diff', async () => {
    const kimi = makeKimi({
      getFileDiff: vi.fn(async () => ({ path: 'src/a.ts', diff: '@@ fake diff' })),
    });
    const handlers = createToolHandlers({ kimi, config: makeConfig() });

    await expect(handlers.kimi_get_diff({ sessionId: 's1', path: 'src/a.ts' })).resolves.toEqual({
      path: 'src/a.ts',
      diff: '@@ fake diff',
    });
  });

  it('aborts a session', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig() });

    await expect(handlers.kimi_abort({ sessionId: 's1' })).resolves.toEqual({ sessionId: 's1', aborted: true });
    expect(kimi.abortSession).toHaveBeenCalledWith('s1');
  });

  it('fails fast when no model is configured', async () => {
    const kimi = makeKimi({
      resolveDefaultModel: vi.fn(async () => undefined),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ defaultModel: undefined }),
    });

    await expect(handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
    })).rejects.toThrow(/model/);
  });

  it('returns pending approvals when Kimi waits for approval', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_approval' })),
      listPendingApprovals: vi.fn(async () => [{ approval_id: 'a1', tool_name: 'Bash' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({
      status: 'awaiting_approval',
      approvals: [{ approval_id: 'a1', tool_name: 'Bash' }],
    });
  });

  it('returns pending questions when Kimi waits for a question', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_question' })),
      listPendingQuestions: vi.fn(async () => [{ question_id: 'q1', questions: [] }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({
      status: 'awaiting_question',
      questions: [{ question_id: 'q1', questions: [] }],
    });
  });
});
