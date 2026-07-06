import { describe, expect, it, vi } from 'vitest';
import { createToolHandlers } from '../src/tools.js';

describe('tool handlers', () => {
  it('delegates a task by creating a session and submitting a prompt', async () => {
    const kimi = {
      createSession: vi.fn(async () => ({ id: 's1' })),
      submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
    };
    const handlers = createToolHandlers({
      kimi: kimi as never,
      config: {
        serverUrl: 'http://127.0.0.1:58627',
        defaultModel: 'kimi-k2',
        defaultThinking: 'high',
        defaultPermissionMode: 'auto',
        requestTimeoutMs: 30000,
      },
    });

    await expect(handlers.kimi_delegate_task({
      cwd: '/repo',
      task: 'implement x',
      acceptanceCriteria: ['passes tests'],
      plan: ['edit code'],
      swarmMode: false,
    })).resolves.toMatchObject({ sessionId: 's1', promptId: 'p1' });
  });
});
