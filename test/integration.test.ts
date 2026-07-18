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
});
