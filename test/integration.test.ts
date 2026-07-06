import { afterEach, describe, expect, it } from 'vitest';
import { KimiHttpClient } from '../src/kimi/http.js';
import { KimiClient } from '../src/kimi/client.js';
import { startFakeKimiServer, type FakeKimiServer } from './fixtures/fake-kimi-server.js';

let server: FakeKimiServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('bridge integration', () => {
  it('creates a session and submits a prompt to a Kimi-compatible server', async () => {
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
    expect(prompt.prompt_id).toBe('p1');
  });
});
