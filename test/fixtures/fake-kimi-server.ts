import { createServer, type Server } from 'node:http';

export interface FakeKimiServer {
  url: string;
  close(): Promise<void>;
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'req_fake' });
}

export async function startFakeKimiServer(): Promise<FakeKimiServer> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/api/v1/sessions') {
      res.end(envelope({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1/prompts') {
      res.end(envelope({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/messages') {
      res.end(envelope({
        items: [
          { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'Implementation complete.' }] },
        ],
      }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1') {
      res.end(envelope({ id: 's1', title: 'test', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1/fs:git_status') {
      res.end(envelope({ entries: { 'src/a.ts': 'M' }, additions: 10, deletions: 2 }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1/fs:diff') {
      res.end(envelope({ path: 'src/a.ts', diff: '@@ fake diff' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/config') {
      res.end(envelope({ default_model: 'kimi-k2' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/v1/sessions/s1:abort') {
      res.end(envelope({ aborted: true }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/approvals?status=pending') {
      res.end(envelope({ items: [{ approval_id: 'a1', tool_name: 'Bash' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/api/v1/sessions/s1/questions?status=pending') {
      res.end(envelope({ items: [{ question_id: 'q1', questions: [] }] }));
      return;
    }
    res.end(JSON.stringify({ code: 40401, msg: `not found: ${req.method} ${req.url}`, data: {}, request_id: 'req_404' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake server did not bind to a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
