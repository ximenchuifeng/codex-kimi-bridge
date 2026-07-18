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
      cwd: '.',
    });
    expect(existsSync(bundlePath)).toBe(true);
  });

  it('starts after the plugin is copied away from the repository', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'kimi-delegate-package-'));
    const copiedPluginRoot = join(temporaryRoot, 'kimi-delegate');
    cpSync(pluginRoot, copiedPluginRoot, { recursive: true });

    const config = JSON.parse(readFileSync(join(copiedPluginRoot, '.mcp.json'), 'utf8'));
    const serverConfig = config.mcpServers['kimi-delegate'];
    const spawnCwd = resolve(copiedPluginRoot, serverConfig.cwd);

    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: serverConfig.args,
      cwd: spawnCwd,
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

  it('contains portable release metadata', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'),
    );

    expect(packageJson).toMatchObject({
      version: '0.3.0',
      license: 'MIT',
      author: 'ximenchuifeng',
      repository: {
        type: 'git',
        url: 'git+https://github.com/ximenchuifeng/codex-kimi-bridge.git',
      },
      homepage: 'https://github.com/ximenchuifeng/codex-kimi-bridge#readme',
      engines: { node: '>=20' },
    });
    expect(manifest).toMatchObject({
      name: 'kimi-delegate',
      version: '0.3.0',
      license: 'MIT',
      homepage: 'https://github.com/ximenchuifeng/codex-kimi-bridge#readme',
      repository: 'https://github.com/ximenchuifeng/codex-kimi-bridge',
      author: {
        name: 'ximenchuifeng',
        url: 'https://github.com/ximenchuifeng',
      },
      interface: { developerName: 'ximenchuifeng' },
    });
    expect(existsSync(resolve('LICENSE'))).toBe(true);

    const readme = readFileSync(resolve('README.md'), 'utf8');
    const skill = readFileSync(join(pluginRoot, 'skills/kimi-delegate/SKILL.md'), 'utf8');
    expect(readme).toContain('committedChanges');
    expect(readme).toContain('workingTreeChanges');
    expect(readme).toContain('initialDirtyPaths');
    expect(skill).toContain('committedChanges');
    expect(skill).toContain('workingTreeChanges');
    expect(skill).toContain('initialDirtyPaths');
  });

  it('uses a basename-aware guard so the bundle starts main exactly once', () => {
    const bundleText = readFileSync(bundlePath, 'utf8');

    // The previous equality guard would be true when server.mjs is launched
    // directly, causing src/index.ts and src/plugin-entry.ts to both call main().
    expect(bundleText).not.toContain('if (import.meta.url === `file://${process.argv[1]}`)');
    // The new guard must compare the module URL with the actual argv entry path.
    expect(bundleText).toContain('isDirectExecution(import.meta.url, process.argv[1])');
  });

  it('does not package machine-specific paths or credential values', () => {
    const configText = readFileSync(join(pluginRoot, '.mcp.json'), 'utf8');
    const bundleText = readFileSync(bundlePath, 'utf8');

    // The bundle legitimately contains a token-redaction regex literal and its
    // replacement string. Strip those before scanning for real token-bearing URLs.
    const sanitizedBundle = bundleText
      .split('/#token=[^\\s]+/gi').join('')
      .split('#token=[redacted]').join('');
    const packagedText = `${configText}\n${sanitizedBundle}`;

    expect(packagedText).not.toContain('/Users/ximenchuifeng');
    expect(packagedText).not.toContain(resolve('.'));
    expect(packagedText).not.toContain('Authorization: Bearer');
    expect(packagedText).not.toContain('#token=');

    const configuredToken = process.env.KIMI_SERVER_TOKEN?.trim();
    if (configuredToken) expect(packagedText).not.toContain(configuredToken);
  });
});
