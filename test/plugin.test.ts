import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Codex plugin manifest', () => {
  it('passes local plugin validation', () => {
    expect(() => {
      execFileSync(
        'python3',
        [
          '/Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py',
          'plugins/kimi-delegate',
        ],
        { stdio: 'pipe' },
      );
    }).not.toThrow();
  });
});
