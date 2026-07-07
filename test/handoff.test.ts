import { describe, expect, it } from 'vitest';
import { buildHandoff } from '../src/handoff.js';

describe('buildHandoff', () => {
  it('extracts changed files and final assistant text', () => {
    const handoff = buildHandoff({
      messages: [
        { role: 'assistant', content: 'Working...' },
        { role: 'assistant', content: 'files changed\n- src/a.ts\ncommands run\n- pnpm test' },
      ],
      gitStatus: { entries: { 'src/a.ts': 'M' }, additions: 10, deletions: 2 },
      diffs: [{ path: 'src/a.ts', diff: '@@ fake diff' }],
      waitStatus: 'idle',
    });

    expect(handoff.finalMessage).toContain('files changed');
    expect(handoff.changedFiles).toEqual(['src/a.ts']);
    expect(handoff.diffs).toHaveLength(1);
  });

  it('uses an explicit changedFiles override when provided', () => {
    const handoff = buildHandoff({
      messages: [],
      gitStatus: { entries: { 'tmp/': '??' }, additions: 0, deletions: 0 },
      diffs: [{ path: 'tmp/file.txt', diff: '@@ fake diff' }],
      waitStatus: 'idle',
      changedFiles: ['tmp/file.txt'],
    });

    expect(handoff.changedFiles).toEqual(['tmp/file.txt']);
  });
});
