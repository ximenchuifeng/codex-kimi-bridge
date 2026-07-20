import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileBaselineStore, InMemoryBaselineStore } from '../src/baseline-store.js';
import type { GitBaseline } from '../src/git.js';

function makeBaseline(overrides: Partial<GitBaseline> = {}): GitBaseline {
  return {
    schemaVersion: 1,
    baseCommit: 'a'.repeat(40),
    baseBranch: 'main',
    initialDirtyPaths: ['src/a.ts'],
    worktrees: [{ path: '/repo', headCommit: 'a'.repeat(40) }],
    ...overrides,
  };
}

describe('FileBaselineStore', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    dirs = [];
  });

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'baseline-store-test-'));
    dirs.push(dir);
    return dir;
  }

  it('saves and loads a baseline', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline = makeBaseline();

    await store.save('session-1', baseline);
    const loaded = await store.load('session-1');

    expect(loaded).toEqual(baseline);
  });

  it('returns undefined for an unknown session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });

    expect(await store.load('unknown')).toBeUndefined();
  });

  it('returns undefined for invalid file contents', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const file = join(stateDir, 'SEh0dHA6Ly8xMjcuMC4wLjE6NTg2Mjc', 'c2Vzc2lvbi0x.json');
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, '{"schema_version": 1, "base_commit": "not-valid"}', 'utf8');

    expect(await store.load('session-1')).toBeUndefined();
  });

  it('keeps different sessions in separate files', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const first = makeBaseline({ baseCommit: 'a'.repeat(40) });
    const second = makeBaseline({ baseCommit: 'b'.repeat(40) });

    await store.save('session-a', first);
    await store.save('session-b', second);

    expect(await store.load('session-a')).toEqual(first);
    expect(await store.load('session-b')).toEqual(second);
  });

  it('isolates baselines by server URL', async () => {
    const stateDir = await tmpDir();
    const storeA = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const storeB = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58628' });
    const baseline = makeBaseline();

    await storeA.save('session-1', baseline);

    expect(await storeA.load('session-1')).toEqual(baseline);
    expect(await storeB.load('session-1')).toBeUndefined();
  });

  it('overwrites an existing baseline for the same session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const first = makeBaseline({ baseCommit: 'a'.repeat(40) });
    const second = makeBaseline({ baseCommit: 'b'.repeat(40) });

    await store.save('session-1', first);
    await store.save('session-1', second);

    expect(await store.load('session-1')).toEqual(second);
  });

  it('round-trips a baseline with no optional fields', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline: GitBaseline = {
      schemaVersion: 1,
      baseCommit: 'c'.repeat(40),
      initialDirtyPaths: [],
    };

    await store.save('session-1', baseline);

    expect(await store.load('session-1')).toEqual(baseline);
  });

  it('filters invalid worktree entries on load', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline = makeBaseline({
      worktrees: [
        { path: '/repo', headCommit: 'a'.repeat(40) },
        { path: '', headCommit: 'b'.repeat(40) },
        { path: '/bad', headCommit: 'not-a-valid-id' },
        { path: '/empty-head', headCommit: '' },
      ],
    });

    await store.save('session-1', baseline);
    const loaded = await store.load('session-1');

    expect(loaded?.worktrees).toEqual([{ path: '/repo', headCommit: 'a'.repeat(40) }]);
  });

  it('uses a SHA-256 hex directory name derived from the server URL', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const store = new FileBaselineStore({ stateDir, serverUrl });

    await store.save('session-1', makeBaseline());

    const entries = await readdir(stateDir);
    expect(entries).toHaveLength(1);
    const dirName = entries[0];
    expect(dirName).toMatch(/^[0-9a-f]{64}$/);
    expect(dirName).not.toBe(Buffer.from(serverUrl, 'utf8').toString('base64url'));
  });

  it('isolates baselines by normalized server URL', async () => {
    const stateDir = await tmpDir();
    const canonicalUrl = 'http://127.0.0.1:58627';
    const variantUrl = 'HTTP://127.0.0.1:58627';
    const otherUrl = 'http://127.0.0.1:58628';
    const storeCanonical = new FileBaselineStore({ stateDir, serverUrl: canonicalUrl });
    const storeVariant = new FileBaselineStore({ stateDir, serverUrl: variantUrl });
    const storeOther = new FileBaselineStore({ stateDir, serverUrl: otherUrl });

    await storeCanonical.save('session-1', makeBaseline());

    expect(await storeVariant.load('session-1')).toEqual(await storeCanonical.load('session-1'));
    expect(await storeOther.load('session-1')).toBeUndefined();
  });

  it('survives concurrent saves for the same session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });

    const baselines: GitBaseline[] = Array.from({ length: 10 }, (_, i) =>
      makeBaseline({ baseCommit: String(i).padStart(40, '0') }),
    );

    await Promise.all(baselines.map((baseline) => store.save('session-1', baseline)));

    const loaded = await store.load('session-1');
    expect(loaded).toBeDefined();
    expect(baselines.map((b) => b.baseCommit)).toContain(loaded!.baseCommit);
  });
});

describe('InMemoryBaselineStore', () => {
  it('saves and loads baselines in memory', async () => {
    const store = new InMemoryBaselineStore();
    const baseline = makeBaseline();

    await store.save('session-1', baseline);

    expect(await store.load('session-1')).toEqual(baseline);
    expect(await store.load('session-2')).toBeUndefined();
  });
});
