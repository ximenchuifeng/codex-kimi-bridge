import { describe, expect, it } from 'vitest';
import { buildHandoff, type HandoffChangeSet } from '../src/handoff.js';

function makeChangeSet(overrides: Partial<HandoffChangeSet> = {}): HandoffChangeSet {
  return {
    available: true,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    diffs: [],
    truncatedPaths: [],
    ...overrides,
  };
}

describe('buildHandoff', () => {
  it('extracts changed files and final assistant text', () => {
    const handoff = buildHandoff({
      messages: [
        { role: 'assistant', content: 'files changed\n- src/a.ts\ncommands run\n- pnpm test' },
        { role: 'assistant', content: 'Working...' },
      ],
      waitStatus: 'idle',
      baseCommit: 'abc123',
      headCommit: 'def456',
      commits: [{ sha: 'def456', shortSha: 'def456', subject: 'feat: x' }],
      initialDirtyPaths: [],
      committedChanges: makeChangeSet({
        changedFiles: ['src/a.ts'],
        additions: 10,
        deletions: 2,
        diffs: [{ path: 'src/a.ts', diff: '@@ fake diff', source: 'committed' }],
      }),
      workingTreeChanges: makeChangeSet(),
    });

    expect(handoff.finalMessage).toContain('files changed');
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.diffs).toHaveLength(1);
    expect(handoff.additions).toBe(10);
    expect(handoff.deletions).toBe(2);
  });

  it('selects the newest non-empty assistant message when messages are newest-first', () => {
    const handoff = buildHandoff({
      messages: [
        { role: 'assistant', content: 'new final report' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'old report' },
      ],
      waitStatus: 'idle',
      commits: [],
      initialDirtyPaths: [],
      committedChanges: makeChangeSet(),
      workingTreeChanges: makeChangeSet(),
    });

    expect(handoff.finalMessage).toBe('new final report');
  });

  it('aggregates committed-only changes at the top level', () => {
    const committed = makeChangeSet({
      changedFiles: ['committed.ts'],
      additions: 5,
      deletions: 1,
      diffs: [{ path: 'committed.ts', diff: '@@ committed', source: 'committed' }],
    });
    const handoff = buildHandoff({
      messages: [],
      waitStatus: 'idle',
      baseCommit: 'base',
      headCommit: 'head',
      commits: [{ sha: 'head', shortSha: 'head', subject: 'feat' }],
      initialDirtyPaths: [],
      committedChanges: committed,
      workingTreeChanges: makeChangeSet(),
    });

    expect(handoff.baseCommit).toBe('base');
    expect(handoff.headCommit).toBe('head');
    expect(handoff.commits).toEqual([{ sha: 'head', shortSha: 'head', subject: 'feat' }]);
    expect(handoff.committedChanges).toBe(committed);
    expect(handoff.workingTreeChanges).toEqual(makeChangeSet());
    expect(handoff.changedFiles).toEqual(['committed.ts']);
    expect(handoff.additions).toBe(5);
    expect(handoff.deletions).toBe(1);
    expect(handoff.diffs).toEqual([{ path: 'committed.ts', diff: '@@ committed', source: 'committed' }]);
  });

  it('aggregates working-tree-only changes at the top level', () => {
    const working = makeChangeSet({
      changedFiles: ['working.ts'],
      additions: 3,
      deletions: 0,
      diffs: [{ path: 'working.ts', diff: '@@ working', source: 'working_tree' }],
    });
    const handoff = buildHandoff({
      messages: [],
      waitStatus: 'idle',
      commits: [],
      initialDirtyPaths: [],
      committedChanges: makeChangeSet(),
      workingTreeChanges: working,
    });

    expect(handoff.changedFiles).toEqual(['working.ts']);
    expect(handoff.additions).toBe(3);
    expect(handoff.deletions).toBe(0);
    expect(handoff.diffs).toEqual([{ path: 'working.ts', diff: '@@ working', source: 'working_tree' }]);
  });

  it('aggregates mixed committed and working-tree changes', () => {
    const committed = makeChangeSet({
      changedFiles: ['committed.ts', 'same.ts'],
      additions: 5,
      deletions: 1,
      diffs: [
        { path: 'committed.ts', diff: '@@ committed', source: 'committed' },
        { path: 'same.ts', diff: '@@ same committed', source: 'committed' },
      ],
    });
    const working = makeChangeSet({
      changedFiles: ['same.ts', 'working.ts'],
      additions: 3,
      deletions: 2,
      diffs: [
        { path: 'same.ts', diff: '@@ same working', source: 'working_tree' },
        { path: 'working.ts', diff: '@@ working', source: 'working_tree' },
      ],
    });
    const handoff = buildHandoff({
      messages: [],
      waitStatus: 'idle',
      commits: [{ sha: 'head', shortSha: 'head', subject: 'feat' }],
      initialDirtyPaths: [],
      committedChanges: committed,
      workingTreeChanges: working,
    });

    expect(handoff.changedFiles).toEqual(['committed.ts', 'same.ts', 'working.ts']);
    expect(handoff.additions).toBe(8);
    expect(handoff.deletions).toBe(3);
    expect(handoff.diffs.filter((item) => item.path === 'same.ts')).toEqual([
      expect.objectContaining({ source: 'committed' }),
      expect.objectContaining({ source: 'working_tree' }),
    ]);
  });

  it('surfaces initial dirty paths and unavailable committed ranges', () => {
    const committed = makeChangeSet({
      available: false,
      unavailableReason: 'baseline_unavailable',
    });
    const handoff = buildHandoff({
      messages: [],
      waitStatus: 'idle',
      commits: [],
      initialDirtyPaths: ['pre-existing.ts'],
      committedChanges: committed,
      workingTreeChanges: makeChangeSet(),
    });

    expect(handoff.initialDirtyPaths).toEqual(['pre-existing.ts']);
    expect(handoff.committedChanges.available).toBe(false);
    expect(handoff.committedChanges.unavailableReason).toBe('baseline_unavailable');
  });
});
