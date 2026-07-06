import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadBridgeConfig } from './config.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiClient } from './kimi/client.js';
import { createToolHandlers } from './tools.js';

export async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const kimi = new KimiClient(new KimiHttpClient(config.serverUrl));
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
    async (input) => {
      try {
        const result = await handlers.kimi_delegate_task(input);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
