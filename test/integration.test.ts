import { afterEach, describe, expect, it, vi } from 'vitest';
import { KimiHttpClient } from '../src/kimi/http.js';
import { KimiClient } from '../src/kimi/client.js';
import { startFakeKimiServer, type FakeKimiServer } from './fixtures/fake-kimi-server.js';
import { createToolHandlers } from '../src/tools.js';
import type { BridgeConfig } from '../src/config.js';
import type { KimiPreflight } from '../src/preflight.js';
import type { GitInspector } from '../src/git.js';

let server: FakeKimiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    serverUrl: 'http://127.0.0.1:58627',
    defaultModel: 'kimi-k2',
    defaultThinking: 'high',
    defaultPermissionMode: 'auto',
    requestTimeoutMs: 5000,
    serverTokenSource: 'none',
    autoStart: true,
    kimiCommand: 'kimi',
    preflightCacheMs: 5000,
    ...overrides,
  };
}

function makePreflight(): KimiPreflight {
  return {
    getStatus: vi.fn(async () => ({ healthzOk: true, authOk: true, serverUrl: 'http://127.0.0.1:58627', diagnostics: [] })),
    ensureReady: vi.fn(async () => undefined),
  } as unknown as KimiPreflight;
}

function makeFakeGitInspector(): GitInspector {
  return {
    captureBaseline: vi.fn<GitInspector['captureBaseline']>(async () => ({ available: false, unavailableReason: 'not_a_git_repository' })),
    collectCommittedChanges: vi.fn<GitInspector['collectCommittedChanges']>(async () => ({
      baseCommit: undefined,
      headCommit: undefined,
      commits: [],
      changeSet: {
        available: false,
        changedFiles: [],
        additions: 0,
        deletions: 0,
        diffs: [],
        truncatedPaths: [],
        unavailableReason: 'baseline_unavailable',
      },
    })),
  };
}

describe('bridge integration', () => {
  it('creates a session, submits a prompt, and reads messages/git/diff from a Kimi-compatible server', async () => {
    server = await startFakeKimiServer();
    const kimi = new KimiClient(new KimiHttpClient(server.url));
    const session = await kimi.createSession({ cwd: '/repo', title: 'test' });
    const prompt = await kimi.submitPrompt(session.id, {
      content: 'hello',
      model: 'default',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      swarmMode: true,
    });

    expect(session.id).toBe('s1');
    expect(session.status).toBe('idle');
    await expect(kimi.getRuntimeStatus(session.id)).resolves.toBe('idle');
    await expect(kimi.getMeta()).resolves.toEqual({ server_version: '0.27.0', backend: 'v2' });
    expect(prompt.prompt_id).toBe('p1');

    const messages = await kimi.listMessages(session.id);
    expect(messages).toEqual([{ role: 'assistant', content: 'Implementation complete.' }]);

    const gitStatus = await kimi.getGitStatus(session.id);
    expect(gitStatus).toEqual({ entries: { 'src/a.ts': 'M' }, additions: 10, deletions: 2 });

    const diff = await kimi.getFileDiff(session.id, 'src/a.ts');
    expect(diff).toEqual({ path: 'src/a.ts', diff: '@@ fake diff' });

    await expect(kimi.abortSession(session.id)).resolves.toEqual({ aborted: true });
  });

  it('returns an enriched handoff and review package from delegate-and-wait', async () => {
    server = await startFakeKimiServer();
    const kimi = new KimiClient(new KimiHttpClient(server.url));
    const gitInspector = makeFakeGitInspector();
    const handlers = createToolHandlers({ kimi, config: makeConfig(), preflight: makePreflight(), gitInspector });

    const result = await handlers.kimi_delegate_and_wait({
      cwd: '/repo',
      task: 'integration test',
      acceptanceCriteria: ['tests pass'],
      plan: ['edit code'],
      timeoutMs: 1000,
    });

    expect(result.handoff).toBeDefined();
    expect(result.handoff?.status).toBe('idle');
    expect(result.handoff?.committedChanges.available).toBe(false);
    expect(result.handoff?.workingTreeChanges.available).toBe(true);
    expect(result.handoff?.workingTreeChanges.changedFiles).toContain('src/a.ts');
    expect(result.reviewPackage).toBeDefined();
    expect(result.reviewPackage?.diffStats.committed).toBeDefined();
    expect(result.reviewPackage?.diffStats.workingTree).toBeDefined();
    expect(result.reviewPackage?.reviewChecklist.some((item) => item.includes('committedChanges'))).toBe(true);
  });
});
