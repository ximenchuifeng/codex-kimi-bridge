import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadBridgeConfig } from './config.js';
import { KimiApiError, KimiNetworkError } from './errors.js';
import { KimiHttpClient } from './kimi/http.js';
import { KimiClient } from './kimi/client.js';
import { createToolHandlers } from './tools.js';
import { KimiPreflight } from './preflight.js';

function summarizeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return String(cause);
}

export async function runToolHandler(handler: () => Promise<unknown>): Promise<{
  content: [{ type: 'text'; text: string }];
  isError?: true;
}> {
  try {
    const result = await handler();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    if (error instanceof KimiApiError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              code: error.code,
              requestId: error.requestId,
              details: error.details,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    if (error instanceof KimiNetworkError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error.message,
              code: 'NETWORK',
              cause: summarizeCause(error.cause),
              stack: error.stack,
            }, null, 2),
          },
        ],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: message,
            code: 'UNKNOWN',
            stack: error instanceof Error ? error.stack : undefined,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
}

export async function main(): Promise<void> {
  const config = loadBridgeConfig();
  const http = new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs, config.serverToken);
  const preflight = new KimiPreflight(config, http);
  const kimi = new KimiClient(http);
  const handlers = createToolHandlers({ kimi, config, preflight });
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
    async (input) => runToolHandler(() => handlers.kimi_delegate_task(input)),
  );

  server.tool(
    'kimi_delegate_and_wait',
    {
      cwd: z.string(),
      task: z.string(),
      acceptanceCriteria: z.array(z.string()),
      plan: z.array(z.string()),
      timeoutMs: z.number().optional(),
      swarmMode: z.boolean().optional(),
      sessionId: z.string().optional(),
      model: z.string().optional(),
      thinking: z.string().optional(),
      dedupe: z.object({
        titleContains: z.string(),
        status: z.string().optional(),
        pageSize: z.number().optional(),
        includeArchive: z.boolean().optional(),
        excludeEmpty: z.boolean().optional(),
        reuseIfStatus: z.array(z.string()).optional(),
        matchAnyCwd: z.boolean().optional(),
      }).optional(),
    },
    async (input) => runToolHandler(() => handlers.kimi_delegate_and_wait(input)),
  );

  server.tool(
    'kimi_wait_until_idle',
    {
      sessionId: z.string(),
      timeoutMs: z.number().optional(),
    },
    async (input) => runToolHandler(() => handlers.kimi_wait_until_idle(input)),
  );

  server.tool(
    'kimi_get_handoff',
    {
      sessionId: z.string(),
    },
    async (input) => runToolHandler(() => handlers.kimi_get_handoff(input)),
  );

  server.tool(
    'kimi_review_package',
    {
      sessionId: z.string(),
    },
    async (input) => runToolHandler(() => handlers.kimi_review_package(input)),
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
    async (input) => runToolHandler(() => handlers.kimi_continue_task(input)),
  );

  server.tool(
    'kimi_get_diff',
    {
      sessionId: z.string(),
      path: z.string(),
    },
    async (input) => runToolHandler(() => handlers.kimi_get_diff(input)),
  );

  server.tool(
    'kimi_abort',
    {
      sessionId: z.string(),
    },
    async (input) => runToolHandler(() => handlers.kimi_abort(input)),
  );

  server.tool(
    'kimi_bridge_status',
    {},
    async () => runToolHandler(() => handlers.kimi_bridge_status()),
  );

  server.tool(
    'kimi_recent_sessions',
    {
      pageSize: z.number().optional(),
      status: z.string().optional(),
      includeArchive: z.boolean().optional(),
      excludeEmpty: z.boolean().optional(),
    },
    async (input) => runToolHandler(() => handlers.kimi_recent_sessions(input)),
  );

  server.tool(
    'kimi_find_recent_session',
    {
      titleContains: z.string(),
      status: z.string().optional(),
      pageSize: z.number().optional(),
      includeArchive: z.boolean().optional(),
      excludeEmpty: z.boolean().optional(),
      cwd: z.string().optional(),
      matchAnyCwd: z.boolean().optional(),
    },
    async (input) => runToolHandler(() => handlers.kimi_find_recent_session(input)),
  );

  await server.connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
