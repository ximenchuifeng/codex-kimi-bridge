import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NodeGitInspector, type GitBaseline, type BaselineCaptureResult } from '../src/git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return result.stdout;
}

async function initRepo(prefix = 'git-inspector-test-'): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await git(repo, 'init');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.com');
  return repo;
}

async function commitFile(repo: string, path: string, content: string, message: string): Promise<void> {
  const fullPath = join(repo, path);
  await mkdir(join(fullPath, '..'), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
  await git(repo, 'add', path);
  await git(repo, 'commit', '-m', message);
}

describe('NodeGitInspector', () => {
  let repos: string[] = [];

  afterEach(async () => {
    for (const repo of repos) {
      try {
        await rm(repo, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    repos = [];
  });

  async function track(repoPromise: Promise<string>): Promise<string> {
    const repo = await repoPromise;
    repos.push(repo);
    return repo;
  }

  it('captures a baseline on a clean repository', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const result = await inspector.captureBaseline(repo);

    expect(result).toMatchObject({
      available: true,
      baseline: {
        schemaVersion: 1,
        baseCommit: expect.any(String),
        initialDirtyPaths: [],
      },
    });
    expect(result.available ? result.baseline.baseCommit : '').toMatch(/^[0-9a-fA-F]{40}$/);
  });

  it('records initial dirty paths', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');
    await writeFile(join(repo, 'src/b.ts'), 'export const b = 2;\n', 'utf8');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const result = await inspector.captureBaseline(repo);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.baseline.initialDirtyPaths).toEqual(['src/b.ts']);
    }
  });

  it('collects committed changes over a baseline', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baselineResult = await inspector.captureBaseline(repo);
    expect(baselineResult.available).toBe(true);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    await commitFile(repo, 'src/a b.ts', 'export const c = 3;\n', 'feat: change spaced file');

    const range = await inspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(true);
    expect(range.commits).toHaveLength(1);
    expect(range.commits[0].subject).toBe('feat: change spaced file');
    expect(range.changeSet.changedFiles).toEqual(['src/a b.ts']);
    expect(range.changeSet.additions).toBeGreaterThan(0);
    expect(range.changeSet.diffs).toHaveLength(1);
    expect(range.changeSet.diffs[0]).toMatchObject({ path: 'src/a b.ts', source: 'committed' });
  });

  it('includes binary files in committed changes with zero additions and deletions', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baselineResult = await inspector.captureBaseline(repo);
    expect(baselineResult.available).toBe(true);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    const binaryPath = 'assets/icon.png';
    const fullPath = join(repo, binaryPath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]), 'binary');
    await git(repo, 'add', binaryPath);
    await git(repo, 'commit', '-m', 'feat: add binary icon');

    const range = await inspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(true);
    expect(range.changeSet.changedFiles).toEqual([binaryPath]);
    expect(range.changeSet.additions).toBe(0);
    expect(range.changeSet.deletions).toBe(0);
    expect(range.changeSet.diffs).toHaveLength(1);
    expect(range.changeSet.diffs[0].path).toBe(binaryPath);
  });

  it('uses the new path for staged renames in initialDirtyPaths', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/old.ts', 'export const old = 1;\n', 'feat: initial');

    await git(repo, 'mv', 'src/old.ts', 'src/new.ts');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const result = await inspector.captureBaseline(repo);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.baseline.initialDirtyPaths).toEqual(['src/new.ts']);
    }
  });

  it('returns an empty but available range when HEAD equals baseline', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baselineResult = await inspector.captureBaseline(repo);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    const range = await inspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(true);
    expect(range.commits).toEqual([]);
    expect(range.changeSet.changedFiles).toEqual([]);
    expect(range.changeSet.additions).toBe(0);
    expect(range.changeSet.deletions).toBe(0);
    expect(range.changeSet.diffs).toEqual([]);
    expect(range.changeSet.truncatedPaths).toEqual([]);
  });

  it('degrades for a non-Git directory', async () => {
    const dir = await track(mkdtemp(join(tmpdir(), 'git-inspector-nongit-')));
    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });

    const baseline = await inspector.captureBaseline(dir);
    expect(baseline.available).toBe(false);
    if (!baseline.available) {
      expect(baseline.unavailableReason).toBe('not_a_git_repository');
    }

    const range = await inspector.collectCommittedChanges(dir);
    expect(range.changeSet.available).toBe(false);
    expect(range.changeSet.unavailableReason).toBe('baseline_unavailable');
  });

  it('degrades for a repository with no commits', async () => {
    const repo = await track(initRepo());
    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });

    const baseline = await inspector.captureBaseline(repo);
    expect(baseline.available).toBe(false);
    if (!baseline.available) {
      expect(baseline.unavailableReason).toBe('head_unavailable');
    }
  });

  it('collectCommittedChanges degrades to head_unavailable when the repository has no commits', async () => {
    const repo = await track(initRepo());
    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });

    const baseline: GitBaseline = {
      schemaVersion: 1,
      baseCommit: '0'.repeat(40),
      initialDirtyPaths: [],
    };

    const range = await inspector.collectCommittedChanges(repo, baseline);
    expect(range.changeSet.available).toBe(false);
    expect(range.changeSet.unavailableReason).toBe('head_unavailable');
  });

  it('degrades when baseline is missing', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const range = await inspector.collectCommittedChanges(repo);

    expect(range.changeSet.available).toBe(false);
    expect(range.changeSet.unavailableReason).toBe('baseline_unavailable');
  });

  it('degrades when baseline object id is invalid', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');
    await commitFile(repo, 'src/b.ts', 'export const b = 2;\n', 'feat: second');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baseline: GitBaseline = {
      schemaVersion: 1,
      baseCommit: 'not-a-valid-object-id',
      initialDirtyPaths: [],
    };

    const range = await inspector.collectCommittedChanges(repo, baseline);
    expect(range.changeSet.available).toBe(false);
    expect(range.changeSet.unavailableReason).toBe('git_command_failed');
  });

  it('degrades when baseline is not an ancestor of HEAD', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');
    const baselineResult = await new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 }).captureBaseline(repo);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    await git(repo, 'checkout', '--orphan', 'other');
    await commitFile(repo, 'src/b.ts', 'export const b = 2;\n', 'feat: other branch');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const range = await inspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(false);
    expect(range.changeSet.unavailableReason).toBe('base_not_ancestor');
  });

  it('passes paths with shell metacharacters safely', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baselineResult = await inspector.captureBaseline(repo);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    const suspiciousName = 'src/$(echo pwned).ts';
    await commitFile(repo, suspiciousName, 'export const x = 1;\n', 'feat: suspicious file');

    const pwnedPath = join(repo, 'pwned');
    try {
      await access(pwnedPath);
      throw new Error('Shell metacharacter was executed during repository setup');
    } catch {
      // expected: pwned file does not exist
    }

    const range = await inspector.collectCommittedChanges(repo, baseline);
    expect(range.changeSet.available).toBe(true);
    expect(range.changeSet.changedFiles).toEqual([suspiciousName]);

    try {
      await access(pwnedPath);
      throw new Error('Shell metacharacter was executed by the Git inspector');
    } catch {
      // expected: pwned file still does not exist
    }
  });

  it('truncates oversized patches and reports them explicitly', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
    const baselineResult = await inspector.captureBaseline(repo);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    const longContent = 'export const value = "' + 'x'.repeat(5_000) + '"\n';
    await commitFile(repo, 'src/large.ts', longContent, 'feat: large file');

    const smallInspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 50 });
    const range = await smallInspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(true);
    expect(range.changeSet.changedFiles).toEqual(['src/large.ts']);
    expect(range.changeSet.additions).toBeGreaterThan(0);
    expect(range.changeSet.diffs).toEqual([]);
    expect(range.changeSet.truncatedPaths).toEqual(['src/large.ts']);
  });

  it('retains file/stat evidence when only the patch is truncated', async () => {
    const repo = await track(initRepo());
    await commitFile(repo, 'src/a.ts', 'export const a = 1;\n', 'feat: initial');

    const baselineResult = await new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 }).captureBaseline(repo);
    const baseline = (baselineResult as BaselineCaptureResult & { available: true }).baseline;

    await commitFile(repo, 'src/small.ts', 'export const s = 1;\n', 'feat: small file');
    const longContent = 'export const value = "' + 'x'.repeat(5_000) + '"\n';
    await commitFile(repo, 'src/large.ts', longContent, 'feat: large file');

    const smallInspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 200 });
    const range = await smallInspector.collectCommittedChanges(repo, baseline);

    expect(range.changeSet.available).toBe(true);
    expect(range.changeSet.changedFiles).toEqual(['src/large.ts', 'src/small.ts']);
    expect(range.commits).toHaveLength(2);
    expect(range.changeSet.diffs).toHaveLength(1);
    expect(range.changeSet.diffs[0].path).toBe('src/small.ts');
    expect(range.changeSet.truncatedPaths).toContain('src/large.ts');
  });
});
