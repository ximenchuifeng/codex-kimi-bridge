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
    listSessions: vi.fn(async () => ({ items: [] })) as unknown as KimiClient['listSessions'],
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

  it('preflights before generating a review package', async () => {
    const preflight = makePreflight();
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });

    await handlers.kimi_review_package({ sessionId: 's1' });

    expect(preflight.ensureReady).toHaveBeenCalled();
  });

  it('returns a review package with handoff, changedFiles, diffStats, and checklist', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done\n- src/a.ts' }]),
      getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M', 'src/b.ts': 'M' }, additions: 10, deletions: 2 })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: path === 'src/a.ts' ? '@@ diff' : '' })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_review_package({ sessionId: 's1' });

    expect(result.sessionId).toBe('s1');
    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
    expect(result.handoff).toMatchObject({ status: 'idle', changedFiles: ['src/a.ts', 'src/b.ts'], additions: 10, deletions: 2 });
    expect(result.changedFiles).toEqual(result.handoff.changedFiles);
    expect(result.diffStats).toEqual({ filesChanged: 2, additions: 10, deletions: 2, diffsWithContent: 1 });
    expect(result.reviewChecklist).toContain('检查 changedFiles 是否符合 scope');
    expect(result.reviewChecklist).toContain('检查 tests/verification 是否在 handoff 中出现');
    expect(result.reviewChecklist).toContain('检查 diff 是否包含无关改动');
    expect(result.reviewChecklist).toContain('必要时继续调用 kimi_continue_task');
  });

  it('url-encodes the session id in the review package webUrl', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => []),
      getGitStatus: vi.fn(async () => ({ entries: {}, additions: 0, deletions: 0 })),
      getSession: vi.fn(async () => ({ id: 'review/session 1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_review_package({ sessionId: 'review/session 1' });

    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/review%2Fsession%201');
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

  it('delegates, waits, and returns a handoff and reviewPackage when idle', async () => {
    const kimi = makeKimi({
      createSession: vi.fn(async () => ({ id: 's1' })),
      submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done\n- src/a.ts' }]),
      getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 4, deletions: 1 })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit src/a.ts'],
      timeoutMs: 1000,
    });

    expect(result).toMatchObject({
      sessionId: 's1',
      promptId: 'p1',
      submitStatus: 'running',
      wait: { status: 'idle' },
      webUrl: 'http://127.0.0.1:58627/sessions/s1',
    });
    expect(result.handoff?.changedFiles).toEqual(['src/a.ts']);
    expect(result.changedFiles).toEqual(['src/a.ts']);
    expect(result.reviewPackage).toBeDefined();
    expect(result.reviewPackage?.sessionId).toBe('s1');
    expect(result.reviewPackage?.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
    expect(result.reviewPackage?.handoff).toBe(result.handoff);
    expect(result.reviewPackage?.changedFiles).toEqual(result.handoff?.changedFiles);
    expect(result.reviewPackage?.diffStats).toEqual({ filesChanged: 1, additions: 4, deletions: 1, diffsWithContent: 1 });
    expect(result.reviewPackage?.reviewChecklist.length).toBeGreaterThan(0);
  });

  it('returns session details without handoff when delegate_and_wait times out', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'running' })),
      listMessages: vi.fn(async () => {
        throw new Error('handoff should not be loaded');
      }),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 20 }), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
      timeoutMs: 20,
    });

    expect(result.wait).toEqual({ status: 'timeout' });
    expect(result.handoff).toBeUndefined();
    expect(result.changedFiles).toBeUndefined();
    expect(result.reviewPackage).toBeUndefined();
    expect(result.sessionId).toBe('s1');
    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
  });

  it('returns diagnostics for timeout status', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'running' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'still working' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ requestTimeoutMs: 20 }), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
      timeoutMs: 20,
    });

    expect(result.wait).toEqual({ status: 'timeout' });
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.recentMessages).toEqual([{ role: 'assistant', content: 'still working' }]);
    expect(result.diagnostics?.lastAssistantMessage).toBe('still working');
    expect(result.diagnostics?.suggestedNextActions).toEqual(expect.arrayContaining([expect.stringContaining('kimi_wait_until_idle')]));
    expect(result.diagnostics?.suggestedNextActions).toEqual(expect.arrayContaining([expect.stringContaining('webUrl')]));
  });

  it('returns diagnostics for aborted status', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'aborted' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'aborted message' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.wait).toEqual({ status: 'aborted' });
    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.recentMessages).toEqual([{ role: 'assistant', content: 'aborted message' }]);
    expect(result.diagnostics?.lastAssistantMessage).toBe('aborted message');
    expect(result.diagnostics?.suggestedNextActions).toEqual(expect.arrayContaining([expect.stringContaining('webUrl')]));
    expect(result.diagnostics?.suggestedNextActions).toEqual(expect.arrayContaining([expect.stringContaining('kimi_continue_task')]));
  });

  it('diagnostics recentMessages contains at most 3 messages with truncated content', async () => {
    const longContent = 'x'.repeat(2000);
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
      { role: 'assistant', content: 'fourth' },
      { role: 'assistant', content: longContent },
    ];
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'timeout' })),
      listMessages: vi.fn(async () => messages),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.diagnostics?.recentMessages).toHaveLength(3);
    expect(result.diagnostics?.recentMessages[0]).toEqual({ role: 'user', content: 'third' });
    expect(result.diagnostics?.recentMessages[1]).toEqual({ role: 'assistant', content: 'fourth' });
    expect(result.diagnostics?.recentMessages[2]).toEqual({ role: 'assistant', content: 'x'.repeat(1000) + '...' });
  });

  it('diagnostics redacts token-like values in recentMessages', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'timeout' })),
      listMessages: vi.fn(async () => [
        { role: 'assistant', content: 'open http://127.0.0.1:58627/#token=url-secret and use config-secret' },
      ]),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ serverToken: 'config-secret' }),
      preflight: makePreflight(),
    });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(JSON.stringify(result.diagnostics)).not.toContain('url-secret');
    expect(JSON.stringify(result.diagnostics)).not.toContain('config-secret');
    expect(result.diagnostics?.recentMessages[0].content).toContain('#token=[redacted]');
    expect(result.diagnostics?.recentMessages[0].content).toContain('use [redacted]');
  });

  it('diagnostics lastAssistantMessage picks the last assistant message', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'timeout' })),
      listMessages: vi.fn(async () => [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'first reply' },
        { role: 'user', content: 'follow up' },
        { role: 'assistant', content: 'last reply' },
      ]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.diagnostics?.lastAssistantMessage).toBe('last reply');
  });

  it('diagnostics lastAssistantMessage is empty when no assistant message exists', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'timeout' })),
      listMessages: vi.fn(async () => [{ role: 'user', content: 'hello' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.diagnostics?.lastAssistantMessage).toBe('');
  });

  it('diagnostics includes messagesUnavailable when listMessages fails', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'timeout' })),
      listMessages: vi.fn(async () => {
        throw new Error('network error with secret-token and http://127.0.0.1:58627/?token=url-secret');
      }),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig({ serverToken: 'secret-token' }), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.diagnostics).toBeDefined();
    expect(result.diagnostics?.recentMessages).toEqual([]);
    expect(result.diagnostics?.messagesUnavailable).toBe(true);
    expect(result.diagnostics?.messageError).toMatch(/network error/);
    expect(JSON.stringify(result.diagnostics)).not.toContain('secret-token');
    expect(JSON.stringify(result.diagnostics)).not.toContain('url-secret');
    expect(result.diagnostics?.suggestedNextActions.length).toBeGreaterThan(0);
  });

  it('timeout and aborted do not load handoff, diff, or reviewPackage', async () => {
    const getGitStatus = vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 }));
    const getFileDiff = vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' }));
    const getSession = vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }));
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'aborted' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'aborted' }]),
      getGitStatus,
      getFileDiff,
      getSession,
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.wait).toEqual({ status: 'aborted' });
    expect(result.handoff).toBeUndefined();
    expect(result.reviewPackage).toBeUndefined();
    expect(getGitStatus).not.toHaveBeenCalled();
    expect(getFileDiff).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('idle delegate_and_wait does not include diagnostics', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
      getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.wait).toEqual({ status: 'idle' });
    expect(result.diagnostics).toBeUndefined();
    expect(result.handoff).toBeDefined();
    expect(result.reviewPackage).toBeDefined();
  });

  it('returns pending approvals when delegate_and_wait is blocked on approval', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_approval' })),
      listPendingApprovals: vi.fn(async () => [{ approval_id: 'a1', tool_name: 'Bash' }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.wait).toEqual({
      status: 'awaiting_approval',
      approvals: [{ approval_id: 'a1', tool_name: 'Bash' }],
    });
    expect(result.handoff).toBeUndefined();
    expect(result.reviewPackage).toBeUndefined();
  });

  it('returns pending questions when delegate_and_wait is blocked on a question', async () => {
    const kimi = makeKimi({
      getStatus: vi.fn(async () => ({ status: 'awaiting_question' })),
      listPendingQuestions: vi.fn(async () => [{ question_id: 'q1', questions: [] }]),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(result.wait).toEqual({
      status: 'awaiting_question',
      questions: [{ question_id: 'q1', questions: [] }],
    });
    expect(result.handoff).toBeUndefined();
    expect(result.reviewPackage).toBeUndefined();
  });

  it('idle delegate_and_wait fetches handoff only once', async () => {
    const getGitStatus = vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 }));
    const kimi = makeKimi({
      createSession: vi.fn(async () => ({ id: 's1' })),
      submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
      getStatus: vi.fn(async () => ({ status: 'idle' })),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
      getGitStatus,
      getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
      getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit src/a.ts'],
      timeoutMs: 1000,
    });

    expect(result.wait.status).toBe('idle');
    expect(getGitStatus).toHaveBeenCalledTimes(1);
    expect(result.reviewPackage?.handoff).toBe(result.handoff);
  });

  it('delegate_and_wait reuses an existing session id', async () => {
    const kimi = makeKimi();
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      sessionId: 'existing/session 1',
      task: 'continue x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(kimi.createSession).not.toHaveBeenCalled();
    expect(result.sessionId).toBe('existing/session 1');
    expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/existing%2Fsession%201');
  });

  it('delegate_and_wait preflights exactly once', async () => {
    const preflight = makePreflight();
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });

    await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
    });

    expect(preflight.ensureReady).toHaveBeenCalledTimes(1);
  });

  it('preflights before listing recent sessions', async () => {
    const preflight = makePreflight();
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });

    await handlers.kimi_recent_sessions({});

    expect(preflight.ensureReady).toHaveBeenCalled();
  });

  it('lists recent sessions with default pageSize 10', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Task 1', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_recent_sessions({});

    expect(kimi.listSessions).toHaveBeenCalledWith({ pageSize: 10 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ sessionId: 's1', title: 'Task 1', status: 'running' });
    expect(result.items[0].webUrl).toBe('http://127.0.0.1:58627/sessions/s1');
  });

  it('passes status, includeArchive, and excludeEmpty to listSessions', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({ items: [] })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    await handlers.kimi_recent_sessions({ pageSize: 20, status: 'running', includeArchive: true, excludeEmpty: true });

    expect(kimi.listSessions).toHaveBeenCalledWith({
      pageSize: 20,
      status: 'running',
      includeArchive: true,
      excludeEmpty: true,
    });
  });

  it('url-encodes session ids in recent session webUrls', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 'a/b c', title: 'Task', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_recent_sessions({});

    expect(result.items[0].webUrl).toBe('http://127.0.0.1:58627/sessions/a%2Fb%20c');
  });

  it('passes through createdAt and updatedAt when present', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Task', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_recent_sessions({});

    expect(result.items[0].createdAt).toBe('2026-01-01T00:00:00Z');
    expect(result.items[0].updatedAt).toBe('2026-01-02T00:00:00Z');
  });

  it('redacts token-like values in recent session titles', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'open http://127.0.0.1:58627/#token=super-secret-token', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'open http://127.0.0.1:58627/?token=another-secret&x=1', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_recent_sessions({});

    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(JSON.stringify(result)).not.toContain('another-secret');
    expect(result.items[0].title).toContain('#token=[redacted]');
    expect(result.items[1].title).toContain('token=[redacted]');
  });

  it('does not leak bridge config token in recent session results', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Task', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ serverToken: 'super-secret-token' }),
      preflight: makePreflight(),
    });

    const result = await handlers.kimi_recent_sessions({});

    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('preflights before finding a recent session by title', async () => {
    const preflight = makePreflight();
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight });

    await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(preflight.ensureReady).toHaveBeenCalled();
  });

  it('throws a clear error when titleContains is empty after trimming', async () => {
    const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight: makePreflight() });

    await expect(handlers.kimi_find_recent_session({ titleContains: '' })).rejects.toThrow(/titleContains/);
    await expect(handlers.kimi_find_recent_session({ titleContains: '   ' })).rejects.toThrow(/titleContains/);
  });

  it('finds sessions case-insensitively', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Implement Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(result.match?.sessionId).toBe('s1');
    expect(result.candidates).toHaveLength(1);
  });

  it('returns the first match and all candidates in server order', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's2', title: 'Another feature task', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's1', title: 'Implement Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's3', title: 'Feature fix', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(result.match?.sessionId).toBe('s2');
    expect(result.candidates.map((c) => c.sessionId)).toEqual(['s2', 's1', 's3']);
  });

  it('uses default pageSize 20 and passes through optional filters', async () => {
    const listSessions = vi.fn(async () => ({ items: [] }));
    const kimi = makeKimi({ listSessions });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    await handlers.kimi_find_recent_session({ titleContains: 'x' });

    expect(listSessions).toHaveBeenCalledWith({ pageSize: 20 });

    await handlers.kimi_find_recent_session({
      titleContains: 'x',
      pageSize: 50,
      status: 'running',
      includeArchive: true,
      excludeEmpty: true,
    });

    expect(listSessions).toHaveBeenLastCalledWith({
      pageSize: 50,
      status: 'running',
      includeArchive: true,
      excludeEmpty: true,
    });
  });

  it('omits match and returns empty candidates with suggestions when nothing matches', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Unrelated task', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'missing' });

    expect(result.match).toBeUndefined();
    expect(result.candidates).toEqual([]);
    expect(result.query.titleContains).toBe('missing');
    expect(result.suggestedNextActions.some((a: string) => a.includes('kimi_recent_sessions'))).toBe(true);
    expect(result.suggestedNextActions.some((a: string) => a.includes('放宽')) || result.suggestedNextActions.some((a: string) => a.includes('widen'))).toBe(true);
  });

  it('suggests waiting or opening webUrl when the matched session is running', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(result.match?.status).toBe('running');
    expect(result.suggestedNextActions.some((a: string) => a.includes('kimi_wait_until_idle'))).toBe(true);
    expect(result.suggestedNextActions.some((a: string) => a.includes(result.match?.webUrl ?? ''))).toBe(true);
  });

  it('suggests review package or opening webUrl when the matched session is idle', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(result.match?.status).toBe('idle');
    expect(result.suggestedNextActions.some((a: string) => a.includes('kimi_review_package'))).toBe(true);
    expect(result.suggestedNextActions.some((a: string) => a.includes(result.match?.webUrl ?? ''))).toBe(true);
  });

  it('suggests continuing or opening webUrl when the matched session is aborted', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature', status: 'aborted', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

    expect(result.match?.status).toBe('aborted');
    expect(result.suggestedNextActions.some((a: string) => a.includes('kimi_continue_task'))).toBe(true);
    expect(result.suggestedNextActions.some((a: string) => a.includes(result.match?.webUrl ?? ''))).toBe(true);
  });

  it('suggests resolving approval/question when the matched session is blocked', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async (input: { status?: string }) => {
        const all = [
          { id: 's1', title: 'Feature', status: 'awaiting_approval', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'Feature', status: 'awaiting_question', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ];
        const items = input.status ? all.filter((s) => s.status === input.status) : all;
        return { items };
      }),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const approvalResult = await handlers.kimi_find_recent_session({ titleContains: 'feature', status: 'awaiting_approval' });
    expect(approvalResult.match?.status).toBe('awaiting_approval');
    expect(approvalResult.suggestedNextActions.some((a: string) => a.includes('approval') || a.includes('审批'))).toBe(true);

    const questionResult = await handlers.kimi_find_recent_session({ titleContains: 'feature', status: 'awaiting_question' });
    expect(questionResult.match?.status).toBe('awaiting_question');
    expect(questionResult.suggestedNextActions.some((a: string) => a.includes('question') || a.includes('问题'))).toBe(true);
  });

  it('redacts token-like values in find result match and candidates', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'open http://127.0.0.1:58627/#token=super-secret-token', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'open http://127.0.0.1:58627/?token=another-secret&x=1', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'open' });

    expect(JSON.stringify(result)).not.toContain('super-secret-token');
    expect(JSON.stringify(result)).not.toContain('another-secret');
    expect(result.match?.title).toContain('#token=[redacted]');
  });

  it('does not leak bridge config token in find result', async () => {
    const kimi = makeKimi({
      listSessions: vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Task', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
        ],
      })),
    });
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: makeConfig({ serverToken: 'config-secret' }),
      preflight: makePreflight(),
    });

    const result = await handlers.kimi_find_recent_session({ titleContains: 'task' });

    expect(JSON.stringify(result)).not.toContain('config-secret');
  });

  it('redacts token-like query text when find has no matches', async () => {
    const handlers = createToolHandlers({
      kimi: makeKimi(),
      config: makeConfig({ serverToken: 'config-secret' }),
      preflight: makePreflight(),
    });

    const result = await handlers.kimi_find_recent_session({
      titleContains: 'http://127.0.0.1:58627/#token=query-secret config-secret',
    });

    expect(JSON.stringify(result)).not.toContain('query-secret');
    expect(JSON.stringify(result)).not.toContain('config-secret');
    expect(result.query.titleContains).toBe('http://127.0.0.1:58627/#token=[redacted] [redacted]');
  });

  describe('dedupe guard in delegate_and_wait', () => {
    it('keeps existing behavior when dedupe is not provided', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
      });

      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.dedupe).toBeUndefined();
      expect(result.reviewPackage).toBeDefined();
    });

    it('throws a clear error when dedupe.titleContains is empty', async () => {
      const handlers = createToolHandlers({ kimi: makeKimi(), config: makeConfig(), preflight: makePreflight() });

      await expect(
        handlers.kimi_delegate_and_wait({
          cwd: '/repo',
          task: 'implement x',
          acceptanceCriteria: ['tests pass'],
          plan: ['edit code'],
          dedupe: { titleContains: '' },
        }),
      ).rejects.toThrow(/titleContains/);

      await expect(
        handlers.kimi_delegate_and_wait({
          cwd: '/repo',
          task: 'implement x',
          acceptanceCriteria: ['tests pass'],
          plan: ['edit code'],
          dedupe: { titleContains: '   ' },
        }),
      ).rejects.toThrow(/titleContains/);
    });

    it('proceeds to delegate when dedupe finds no match and reports the check', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({ items: [] }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(listSessions).toHaveBeenCalledWith({ pageSize: 20 });
      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.dedupe).toMatchObject({ checked: true, matched: false, reused: false });
      expect(result.dedupe?.suggestedNextActions.length).toBeGreaterThan(0);
      expect(result.reviewPackage).toBeDefined();
    });

    it('does not create a new session when dedupe finds a running session', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const getStatus = vi.fn(async () => ({ status: 'idle' }));
      const getGitStatus = vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus,
        getGitStatus,
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(getStatus).not.toHaveBeenCalled();
      expect(getGitStatus).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.webUrl).toBe('http://127.0.0.1:58627/sessions/s2');
      expect(result.wait).toEqual({ status: 'running' });
      expect(result.dedupe).toMatchObject({ checked: true, matched: true, reused: true, reason: 'running', match: { sessionId: 's2', status: 'running' } });
      expect(result.dedupe?.suggestedNextActions.some((a) => a.includes('kimi_wait_until_idle'))).toBe(true);
      expect(result.dedupe?.suggestedNextActions.some((a) => a.includes(result.webUrl))).toBe(true);
      expect(result.handoff).toBeUndefined();
      expect(result.reviewPackage).toBeUndefined();
    });

    it('returns the existing reviewPackage when dedupe finds an idle session', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const getStatus = vi.fn(async () => ({ status: 'idle' }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus,
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 4, deletions: 1 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.wait).toEqual({ status: 'idle' });
      expect(result.dedupe).toMatchObject({ checked: true, matched: true, reused: true, reason: 'idle' });
      expect(result.handoff).toBeDefined();
      expect(result.reviewPackage).toBeDefined();
      expect(result.reviewPackage?.sessionId).toBe('s2');
      expect(result.reviewPackage?.handoff).toBe(result.handoff);
      expect(result.changedFiles).toEqual(['src/a.ts']);
    });

    it('returns pending approvals without creating a new session when dedupe finds an awaiting_approval session', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'awaiting_approval', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const listPendingApprovals = vi.fn(async () => [{ approval_id: 'a1', tool_name: 'Bash' }]);
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'awaiting_approval' })),
        listPendingApprovals,
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'awaiting_approval', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.wait).toEqual({ status: 'awaiting_approval', approvals: [{ approval_id: 'a1', tool_name: 'Bash' }] });
      expect(result.dedupe).toMatchObject({ checked: true, matched: true, reused: true, reason: 'awaiting_approval', match: { sessionId: 's2', status: 'awaiting_approval' } });
      expect(result.dedupe?.suggestedNextActions.some((a) => a.includes('approval') || a.includes('审批'))).toBe(true);
      expect(result.handoff).toBeUndefined();
      expect(result.reviewPackage).toBeUndefined();
    });

    it('returns pending questions without creating a new session when dedupe finds an awaiting_question session', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'awaiting_question', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const listPendingQuestions = vi.fn(async () => [{ question_id: 'q1', questions: [] }]);
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'awaiting_question' })),
        listPendingQuestions,
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'awaiting_question', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.wait).toEqual({ status: 'awaiting_question', questions: [{ question_id: 'q1', questions: [] }] });
      expect(result.dedupe).toMatchObject({ checked: true, matched: true, reused: true, reason: 'awaiting_question', match: { sessionId: 's2', status: 'awaiting_question' } });
      expect(result.dedupe?.suggestedNextActions.some((a) => a.includes('question') || a.includes('问题'))).toBe(true);
      expect(result.handoff).toBeUndefined();
      expect(result.reviewPackage).toBeUndefined();
    });

    it('proceeds to delegate when the matched session status is not supported for reuse', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'aborted', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.sessionId).toBe('s1');
      expect(result.dedupe?.matched).toBe(true);
      expect(result.dedupe?.reused).toBe(false);
      expect(result.dedupe?.reason).toBe('status_not_supported');
      expect(result.reviewPackage).toBeDefined();
    });

    it('respects custom reuseIfStatus in dedupe', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature', reuseIfStatus: ['idle'] },
      });

      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.dedupe?.matched).toBe(true);
      expect(result.dedupe?.reused).toBe(false);
      expect(result.dedupe?.reason).toBe('status_not_reusable');
    });

    it('does not reuse aborted even when reuseIfStatus explicitly includes aborted', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'aborted', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature', reuseIfStatus: ['aborted'] },
      });

      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.sessionId).toBe('s1');
      expect(result.dedupe?.matched).toBe(true);
      expect(result.dedupe?.reused).toBe(false);
      expect(result.dedupe?.reason).toBe('status_not_supported');
      expect(result.reviewPackage).toBeDefined();
    });

    it('redacts token-like values in dedupe query and matched session', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'open http://127.0.0.1:58627/#token=query-secret config-secret', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
      });
      const handlers = createToolHandlers({
        kimi: kimi as never,
        config: makeConfig({ serverToken: 'config-secret' }),
        preflight: makePreflight(),
      });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'http://127.0.0.1:58627/#token=query-secret config-secret' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('query-secret');
      expect(JSON.stringify(result)).not.toContain('config-secret');
      expect(result.dedupe?.match?.title).toContain('#token=[redacted]');
      expect(result.dedupe?.query?.titleContains).toBe('http://127.0.0.1:58627/#token=[redacted] [redacted]');
    });

    it('reuses an idle session with the same cwd by default', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.dedupe?.reused).toBe(true);
      expect(result.dedupe?.reason).toBe('idle');
      expect(result.dedupe?.cwdMatched).toBe(true);
    });

    it('does not reuse a session with a different cwd by default and reports cwd_mismatch', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).toHaveBeenCalled();
      expect(submitPrompt).toHaveBeenCalled();
      expect(result.sessionId).toBe('s1');
      expect(result.dedupe?.reused).toBe(false);
      expect(result.dedupe?.reason).toBe('cwd_mismatch');
      expect(result.dedupe?.cwdMatched).toBe(false);
      expect(result.dedupe?.skippedCandidates?.length).toBe(1);
      expect(result.dedupe?.skippedCandidates?.[0].sessionId).toBe('s2');
      expect(result.dedupe?.skippedCandidates?.[0].cwd).toBe('/other');
    });

    it('ignores trailing slash differences when matching cwd', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo/' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo/' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(result.dedupe?.reused).toBe(true);
      expect(result.dedupe?.cwdMatched).toBe(true);
    });

    it('reuses a session from a different cwd when matchAnyCwd is true', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature', matchAnyCwd: true },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(submitPrompt).not.toHaveBeenCalled();
      expect(result.sessionId).toBe('s2');
      expect(result.dedupe?.reused).toBe(true);
      expect(result.dedupe?.cwdMatched).toBe(false);
    });

    it('reports cwdMatched=true with matchAnyCwd when the session cwd actually matches', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature', matchAnyCwd: true },
      });

      expect(createSession).not.toHaveBeenCalled();
      expect(result.dedupe?.reused).toBe(true);
      expect(result.dedupe?.cwdMatched).toBe(true);
    });

    it('does not leak cwd metadata token-like values in dedupe diagnostics', async () => {
      const createSession = vi.fn(async () => ({ id: 's1' }));
      const submitPrompt = vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      const listSessions = vi.fn(async () => ({
        items: [{ id: 's2', title: 'Feature X', status: 'idle', metadata: { cwd: '/other/#token=secret' }, agent_config: {}, last_seq: 0 }],
      }));
      const kimi = makeKimi({
        createSession,
        submitPrompt,
        listSessions,
        getStatus: vi.fn(async () => ({ status: 'idle' })),
        listMessages: vi.fn(async () => [{ role: 'assistant', content: 'done' }]),
        getGitStatus: vi.fn(async () => ({ entries: { 'src/a.ts': 'M' }, additions: 1, deletions: 0 })),
        getFileDiff: vi.fn(async (_sessionId: string, path: string) => ({ path, diff: '@@ diff' })),
        getSession: vi.fn(async () => ({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      });
      const handlers = createToolHandlers({
        kimi: kimi as never,
        config: makeConfig({ serverToken: 'config-secret' }),
        preflight: makePreflight(),
      });

      const result = await handlers.kimi_delegate_and_wait({
        cwd: '/repo',
        task: 'implement x',
        acceptanceCriteria: ['tests pass'],
        plan: ['edit code'],
        dedupe: { titleContains: 'feature' },
      });

      expect(result.dedupe?.reason).toBe('cwd_mismatch');
      expect(JSON.stringify(result.dedupe)).not.toContain('secret');
      expect(JSON.stringify(result.dedupe)).not.toContain('config-secret');
    });
  });

  describe('cwd filtering in find_recent_session', () => {
    it('returns only sessions matching cwd when cwd is provided', async () => {
      const listSessions = vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'Feature Y', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 },
        ],
      }));
      const kimi = makeKimi({ listSessions });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_find_recent_session({ titleContains: 'feature', cwd: '/repo' });

      expect(result.match?.sessionId).toBe('s1');
      expect(result.candidates.map((c) => c.sessionId)).toEqual(['s1']);
      expect(result.candidates[0].cwd).toBe('/repo');
      expect(result.query.cwd).toBe('/repo');
    });

    it('ignores trailing slash differences when filtering by cwd', async () => {
      const listSessions = vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo/' }, agent_config: {}, last_seq: 0 },
        ],
      }));
      const kimi = makeKimi({ listSessions });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_find_recent_session({ titleContains: 'feature', cwd: '/repo' });

      expect(result.match?.sessionId).toBe('s1');
      expect(result.candidates[0].cwd).toBe('/repo/');
    });

    it('returns all matching sessions when cwd is omitted (legacy behavior)', async () => {
      const listSessions = vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'Feature Y', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 },
        ],
      }));
      const kimi = makeKimi({ listSessions });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_find_recent_session({ titleContains: 'feature' });

      expect(result.match?.sessionId).toBe('s1');
      expect(result.candidates.map((c) => c.sessionId)).toEqual(['s1', 's2']);
    });

    it('returns all cwd matches when matchAnyCwd is true', async () => {
      const listSessions = vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
          { id: 's2', title: 'Feature Y', status: 'idle', metadata: { cwd: '/other' }, agent_config: {}, last_seq: 0 },
        ],
      }));
      const kimi = makeKimi({ listSessions });
      const handlers = createToolHandlers({ kimi: kimi as never, config: makeConfig(), preflight: makePreflight() });

      const result = await handlers.kimi_find_recent_session({ titleContains: 'feature', cwd: '/repo', matchAnyCwd: true });

      expect(result.match?.sessionId).toBe('s1');
      expect(result.candidates.map((c) => c.sessionId)).toEqual(['s1', 's2']);
    });

    it('redacts token-like values in query.cwd and candidate cwd', async () => {
      const listSessions = vi.fn(async () => ({
        items: [
          { id: 's1', title: 'Feature X', status: 'idle', metadata: { cwd: '/repo/#token=secret config-secret' }, agent_config: {}, last_seq: 0 },
        ],
      }));
      const kimi = makeKimi({ listSessions });
      const handlers = createToolHandlers({
        kimi: kimi as never,
        config: makeConfig({ serverToken: 'config-secret' }),
        preflight: makePreflight(),
      });

      const result = await handlers.kimi_find_recent_session({
        titleContains: 'feature',
        cwd: '/repo/#token=secret config-secret',
      });

      expect(JSON.stringify(result)).not.toContain('secret');
      expect(JSON.stringify(result)).not.toContain('config-secret');
      expect(result.query.cwd).toBe('/repo/#token=[redacted] [redacted]');
      expect(result.match?.cwd).toBe('/repo/#token=[redacted] [redacted]');
      expect(result.candidates[0].cwd).toBe('/repo/#token=[redacted] [redacted]');
    });
  });
});
