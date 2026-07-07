import { describe, expect, it, vi } from 'vitest';
import { createToolHandlers } from '../src/tools.js';
import type { KimiClient } from '../src/kimi/client.js';
import type { BridgeConfig } from '../src/config.js';
import type { KimiPreflight } from '../src/preflight.js';

function makeKimi(overrides: Record<string, unknown> = {}): KimiClient {
  return {
    createSession: vi.fn(async () => ({ id: 's1' })) as unknown as KimiClient['createSession'],
    getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })) as unknown as KimiClient['getSession'],
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

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    serverUrl: 'http://127.0.0.1:58627',
    defaultModel: 'kimi-k2',
    defaultThinking: 'high',
    defaultPermissionMode: 'auto',
    requestTimeoutMs: 30000,
    serverToken: undefined,
    serverTokenSource: 'none',
    autoStart: true,
    kimiCommand: 'kimi',
    preflightCacheMs: 5000,
    ...overrides,
  };
}

function makePreflight(overrides: Partial<import('../src/preflight.js').BridgeStatus> = {}): KimiPreflight {
  return {
    ensureReady: vi.fn(async () => ({ healthzOk: true, authOk: true, preflightCacheMs: 5000, ...overrides })),
    getStatus: vi.fn(async () => ({
      serverUrl: 'http://127.0.0.1:58627',
      webBaseUrl: 'http://127.0.0.1:58627/',
      canOpenWeb: true,
      healthzOk: true,
      authOk: true,
      status: 'ready',
      tokenSource: 'home',
      autoStart: true,
      kimiCommand: 'kimi',
      diagnostics: [],
      preflightCacheMs: 5000,
      cacheFresh: false,
      nextActions: ['可以继续委托任务给 Kimi。', '可在浏览器中打开 webBaseUrl 查看 session。'],
      ...overrides,
    })),
  } as unknown as KimiPreflight;
}

describe('tool handlers', () => {
  it('preflights before delegating a task', async () => {
    const preflight = makePreflight();
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });
    await handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    });
    expect(preflight.ensureReady).toHaveBeenCalled();
  });

  it('delegates a task by creating a session and submitting a prompt', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    });

    expect(result).toMatchObject({ sessionId: 's1', promptId: 'p1' });
    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
  });

  it('url-encodes the session id in the webUrl', async () => {
    const kimi = makeKimi({
      createSession: vi.fn(async () => ({ id: 'a/b c' })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    });

    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/a%2Fb%20c');
  });

  it('waits until idle using the configured default timeout', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn()
        .mockResolvedValueOnce({ status: 'running' })
        .mockResolvedValueOnce({ status: 'idle' }),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 1100 }), preflight: makePreflight() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({ status: 'idle' });
    expect(kimi.getStatus).toHaveBeenCalledWith('s1');
  });

  it('returns timeout when the session does not become idle', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'running' })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 50 }), preflight: makePreflight() });

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
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    const handoff = await handlers.kimi_get_handoff({ sessionId: 's1' });

    expect(handoff.status).toBe('idle');
    expect(handoff.finalMessage).toContain('files changed');
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.diffs).toEqual([{ path: 'src/a.ts', diff: '@@ diff for src/a.ts' }]);
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'src/a.ts');
  });

  it('expands untracked directories to concrete file paths', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({
        entries: {
          'src/a.ts': 'M',
          'tmp/': '??',
          'untracked.txt': '??',
        },
        additions: 10,
        deletions: 2,
      })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: `@@ diff for ${path}` })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const fileLister = {
      listFiles: vi.fn(async (_baseDir: string, relativeDir: string) => {
        if (relativeDir === 'tmp/') return ['tmp/kimi-bridge-smoke.txt'];
        return [];
      }),
    };
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight(), fileLister });

    const handoff = await handlers.kimi_get_handoff({ sessionId: 's1' });

    expect(handoff.changedFiles).toEqual([
      'src/a.ts',
      'tmp/kimi-bridge-smoke.txt',
      'untracked.txt',
    ]);
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'src/a.ts');
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'tmp/kimi-bridge-smoke.txt');
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'untracked.txt');
    expect(kimi.getFileDiff).not.toHaveBeenCalledWith('s1', 'tmp/');
  });

  it('keeps the directory path when expansion yields no files', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({ entries: { 'tmp/': '??' }, additions: 0, deletions: 0 })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '' })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const fileLister = {
      listFiles: vi.fn(async () => []),
    };
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight(), fileLister });

    const handoff = await handlers.kimi_get_handoff({ sessionId: 's1' });

    expect(handoff.changedFiles).toEqual(['tmp/']);
    expect(kimi.getFileDiff).toHaveBeenCalledWith('s1', 'tmp/');
  });

  it('continues a task by submitting a follow-up prompt', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_continue_task({
      sessionId: 's1',
      task: 'fix the lint errors',
      acceptanceCriteria: ['lint passes'],
      plan: ['run lint --fix'],
    });

    expect(result).toMatchObject({ sessionId: 's1', promptId: 'p1' });
    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
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
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    await expect(handlers.kimi_get_diff({ sessionId: 's1', path: 'src/a.ts' })).resolves.toEqual({
      path: 'src/a.ts',
      diff: '@@ fake diff',
    });
  });

  it('aborts a session', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    await expect(handlers.kimi_abort({ sessionId: 's1' })).resolves.toEqual({ sessionId: 's1', aborted: true });
    expect(kimi.abortSession).toHaveBeenCalledWith('s1');
  });

  it('returns bridge status without leaking the token', async () => {
    const preflight = makePreflight({
      serverUrl: 'http://127.0.0.1:58627',
      healthzOk: true,
      authOk: true,
      tokenSource: 'home',
      autoStart: true,
      kimiCommand: 'kimi',
      diagnostics: [],
    });
    const handlers = createToolHandlers({
      kimi: makeKimi(),
      config: makeConfig({ serverToken: 'super-secret-token' }),
      preflight,
    });

    const status = await handlers.kimi_bridge_status();
    expect(status.tokenSource).toBe('home');
    expect(status.serverUrl).toBe('http://127.0.0.1:58627');
    expect(status.webBaseUrl).toBe('http://127.0.0.1:58627/');
    expect(status.status).toBe('ready');
    expect(status.canOpenWeb).toBe(true);
    expect(status.nextActions.length).toBeGreaterThan(0);
    expect(status.autoStart).toBe(true);
    expect(status.kimiCommand).toBe('kimi');
    expect(JSON.stringify(status)).not.toContain('super-secret-token');
    expect(preflight.getStatus).toHaveBeenCalled();
    expect(preflight.ensureReady).not.toHaveBeenCalled();
  });

  it('fails fast when no model is configured', async () => {
    const kimi = makeKimi({
      resolveDefaultModel: vi.fn(async () => undefined),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ defaultModel: undefined }),
      preflight: makePreflight(),
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
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

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
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    await expect(handlers.kimi_wait_until_idle({ sessionId: 's1' })).resolves.toEqual({
      status: 'awaiting_question',
      questions: [{ question_id: 'q1', questions: [] }],
    });
  });
});
