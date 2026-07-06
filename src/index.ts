import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadBridgeConfig } from './config.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiClient } from './kimi/client.js';
import { createToolHandlers } from './tools.js';

export async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const kimi = new KimiClient(new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs));
  const handlers = createToolHandlers({ kimi, config });
  const server = new McpServer({ name: 'codex-kimi-bridge', version: '0.1.0' });

  server.tool(
    'kimi_delegate_task',
    {
      cwd: z.string(),
      task: z.string(),
      acceptanceCriteria: z.array(z.string()),
      plan: z.array(z.string()),
      swarmMode: z.boolean().optional(),
      sessionId: z.string().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_delegate_task(input), null, 2) }],
    }),
  );

  server.tool(
    'kimi_wait_until_idle',
    {
      sessionId: z.string(),
      timeoutMs: z.number().optional(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_wait_until_idle(input), null, 2) }],
    }),
  );

  server.tool(
    'kimi_get_handoff',
    {
      sessionId: z.string(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_get_handoff(input), null, 2) }],
    }),
  );

  server.tool(
    'kimi_continue_task',
    {
      sessionId: z.string(),
      task: z.string(),
      acceptanceCriteria: z.array(z.string()).optional(),
      plan: z.array(z.string()).optional(),
      swarmMode: z.boolean().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_continue_task(input), null, 2) }],
    }),
  );

  server.tool(
    'kimi_get_diff',
    {
      sessionId: z.string(),
      path: z.string(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_get_diff(input), null, 2) }],
    }),
  );

  server.tool(
    'kimi_abort',
    {
      sessionId: z.string(),
    },
    async (input) => ({
      content: [{ type: 'text', text: JSON.stringify(await handlers.kimi_abort(input), null, 2) }],
    }),
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
