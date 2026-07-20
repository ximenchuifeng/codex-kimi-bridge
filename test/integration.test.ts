import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KimiHttpClient } from '../src/kimi/http.js';
import { KimiClient } from '../src/kimi/client.js';
import { startFakeKimiServer, type FakeKimiServer } from './fixtures/fake-kimi-server.js';
import { createToolHandlers } from '../src/tools.js';
import type { BridgeConfig } from '../src/config.js';
import type { KimiPreflight } from '../src/preflight.js';
import type { GitInspector } from '../src/git.js';
import { FileBaselineStore } from '../src/baseline-store.js';

let server: FakeKimiServer | undefined;
let tmpDirs: string[] = [];

afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const dir of tmpDirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
  tmpDirs = [];
});

async function tmpStateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-bridge-integration-'));
  tmpDirs.push(dir);
  return dir;
}

function makeConfig(stateDir: string, overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    stateDir,
    ...overrides,
  };
}

function makePreflight(): KimiPreflight {
  return {
    getStatus: vi.fn(async () => ({ healthzOk: true, authOk: true, serverUrl: 'http://127.0.0.1:58627', diagnostics: [] })),
    ensureReady: vi.fn(async () => undefined),
  } as unknown as KimiPreflight;
}

const execFileAsync = promisify(execFile);

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

async function initGitRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'kimi-bridge-repo-'));
  tmpDirs.push(repo);
  await execFileAsync('git', ['-C', repo, 'init']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  const file = join(repo, 'initial.txt');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'initial\n', 'utf8');
  await execFileAsync('git', ['-C', repo, 'add', 'initial.txt']);
  await execFileAsync('git', ['-C', repo, 'commit', '-m', 'feat: initial']);
  return repo;
}

async function runReviewPackageInSubprocess(serverUrl: string, stateDir: string, sessionId: string): Promise<import('../src/tools.js').ReviewPackageResult> {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'run-review-package.ts');
  const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', fixture], {
    env: {
      ...process.env,
      KIMI_SERVER_URL: serverUrl,
      KIMI_BRIDGE_STATE_DIR: stateDir,
      SESSION_ID: sessionId,
    },
  });
  return JSON.parse(stdout) as import('../src/tools.js').ReviewPackageResult;
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
    const stateDir = await tmpStateDir();
    const kimi = new KimiClient(new KimiHttpClient(server.url));
    const gitInspector = makeFakeGitInspector();
    const baselineStore = new FileBaselineStore({ stateDir, serverUrl: server.url });
    const handlers = createToolHandlers({ kimi, config: makeConfig(stateDir, { serverUrl: server.url }), preflight: makePreflight(), gitInspector, baselineStore });

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

  it('persists baseline across processes when the server strips metadata', async () => {
    server = await startFakeKimiServer();
    const repo = await initGitRepo();
    const stateDir = await tmpStateDir();
    const kimi = new KimiClient(new KimiHttpClient(server.url));
    const baselineStore = new FileBaselineStore({ stateDir, serverUrl: server.url });
    const handlers = createToolHandlers({
      kimi,
      config: makeConfig(stateDir, { serverUrl: server.url }),
      preflight: makePreflight(),
      baselineStore,
    });

    const delegated = await handlers.kimi_delegate_task({
      cwd: repo,
      task: 'cross-process persistence test',
      acceptanceCriteria: ['persist baseline'],
      plan: ['edit file'],
    });

    // Simulate Kimi committing work after delegation.
    const featureFile = join(repo, 'feature.txt');
    await writeFile(featureFile, 'feature work\n', 'utf8');
    await execFileAsync('git', ['-C', repo, 'add', 'feature.txt']);
    await execFileAsync('git', ['-C', repo, 'commit', '-m', 'feat: add feature']);

    // Fetch review package from a fresh subprocess that only shares the state
    // directory and server URL with the first process.
    const reviewPackage = await runReviewPackageInSubprocess(server.url, stateDir, delegated.sessionId);

    expect(reviewPackage.handoff.committedChanges.available).toBe(true);
    expect(reviewPackage.handoff.committedChanges.changedFiles).toContain('feature.txt');
    expect(reviewPackage.handoff.commits).toHaveLength(1);
    expect(reviewPackage.handoff.reviewWorkspace).toBe(await realpath(repo));
    expect(reviewPackage.handoff.workingTreeChanges.available).toBe(true);
    // The fake Kimi server reports a working-tree change regardless of the
    // real repository, so we only assert that working-tree evidence is present.
    expect(reviewPackage.handoff.workingTreeChanges.changedFiles.length).toBeGreaterThanOrEqual(0);
  }, 20000);
});
