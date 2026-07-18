import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const pluginRoot = resolve('plugins/kimi-delegate');
const bundlePath = join(pluginRoot, 'mcp/server.mjs');

describe('Codex plugin package', () => {
  it('passes local plugin validation', () => {
    expect(() => {
      execFileSync(
        'python3',
        [
          '/Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py',
          pluginRoot,
        ],
        { stdio: 'pipe' },
      );
    }).not.toThrow();
  });

  it('launches a tracked plugin-relative bundle', () => {
    const config = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
    expect(config.mcpServers['kimi-delegate']).toMatchObject({
      command: 'node',
      args: ['./mcp/server.mjs'],
    });
    expect(existsSync(bundlePath)).toBe(true);
  });

  it('starts after the plugin is copied away from the repository', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'kimi-delegate-package-'));
    const copiedPluginRoot = join(temporaryRoot, 'kimi-delegate');
    cpSync(pluginRoot, copiedPluginRoot, { recursive: true });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['./mcp/server.mjs'],
      cwd: copiedPluginRoot,
      env: {
        HOME: temporaryRoot,
        KIMI_CODE_HOME: join(temporaryRoot, 'kimi-home'),
        KIMI_SERVER_TOKEN: '',
        KIMI_AUTO_START: 'false',
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'portable-plugin-smoke', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const toolNames = result.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        'kimi_bridge_status',
        'kimi_delegate_task',
        'kimi_delegate_and_wait',
        'kimi_review_package',
      ]));
    } finally {
      await client.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
