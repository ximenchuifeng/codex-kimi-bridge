import { describe, expect, it, vi } from 'vitest';
import { KimiClient, type HttpPort } from '../src/kimi/client.js';

describe('KimiClient', () => {
  it('creates a session with cwd metadata', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'Task', agent_config: {}, last_seq: 0 })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await expect(client.createSession({ cwd: '/repo', title: 'Task' })).resolves.toMatchObject({ id: 's1' });
    expect(http.post).toHaveBeenCalledWith('/sessions', { title: 'Task', metadata: { cwd: '/repo' } });
  });

  it('submits prompts with required runtime fields', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await client.submitPrompt('s1', {
      content: 'hello',
      model: 'kimi-k2',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      swarmMode: true,
    });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1/prompts', {
      content: [{ type: 'text', text: 'hello' }],
      model: 'kimi-k2',
      thinking: 'high',
      permission_mode: 'auto',
      plan_mode: false,
      swarm_mode: true,
    });
  });

  it('aborts a session with the real Kimi action suffix route', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ aborted: true })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await expect(client.abortSession('s1')).resolves.toEqual({ aborted: true });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1:abort');
  });

  it('lists pending approvals and questions', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async (path: string) => {
        if (path.includes('/approvals')) return { items: [{ approval_id: 'a1', tool_name: 'Bash' }] };
        if (path.includes('/questions')) return { items: [{ question_id: 'q1', questions: [] }] };
        return {};
      }) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.listPendingApprovals('s1')).resolves.toEqual([{ approval_id: 'a1', tool_name: 'Bash' }]);
    await expect(client.listPendingQuestions('s1')).resolves.toEqual([{ question_id: 'q1', questions: [] }]);

    expect(http.get).toHaveBeenCalledWith('/sessions/s1/approvals', { status: 'pending' });
    expect(http.get).toHaveBeenCalledWith('/sessions/s1/questions', { status: 'pending' });
  });

  it('fetches a session by id', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'Task', agent_config: {}, last_seq: 0 })) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.getSession('s1')).resolves.toMatchObject({ id: 's1', metadata: { cwd: '/repo' } });
    expect(http.get).toHaveBeenCalledWith('/sessions/s1');
  });
});
