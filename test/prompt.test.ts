import { describe, expect, it } from 'vitest';
import { buildDelegationPrompt } from '../src/prompt.js';

describe('buildDelegationPrompt', () => {
  it('includes Codex/Kimi roles and handoff contract', () => {
    const prompt = buildDelegationPrompt({
      task: 'Add a health check endpoint.',
      acceptanceCriteria: ['GET /health returns ok'],
      plan: ['Add route', 'Add test'],
      swarmSuggestions: ['API route', 'test coverage'],
    });

    expect(prompt).toContain('Codex is the coordinator and reviewer');
    expect(prompt).toContain('Add a health check endpoint.');
    expect(prompt).toContain('GET /health returns ok');
    expect(prompt).toContain('If the work has independent parts, use AgentSwarm');
    expect(prompt).toContain('files changed');
    expect(prompt).toContain('tests run and results');
  });
});
