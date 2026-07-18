# Portable Plugin Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the Kimi Delegate MCP server inside the Codex plugin so a fresh Git clone can be installed without developer-specific paths, dependency installation, or a local TypeScript build.

**Architecture:** Add a dedicated executable entry point and bundle it with esbuild into the tracked plugin artifact `plugins/kimi-delegate/mcp/server.mjs`. Launch that artifact through a plugin-root-relative `.mcp.json` path with `"cwd": "."`, and prove portability by copying the plugin to a temporary directory and connecting to it with an MCP stdio client. Keep source behavior unchanged while adding release metadata and clear first-install versus developer-update documentation.

**Tech Stack:** TypeScript, Node.js 20+, ESM, esbuild, Vitest, Model Context Protocol TypeScript SDK, Codex plugin manifests.

## Global Constraints

- Target Node.js 20 or newer and emit an ESM plugin bundle.
- Keep plugin ID `kimi-delegate@codex-kimi-bridge-local` and marketplace name `codex-kimi-bridge-local` unchanged.
- Use `node ./mcp/server.mjs` as the installed MCP launch command.
- Track `plugins/kimi-delegate/mcp/server.mjs` in Git so first-time users do not need pnpm or a build step.
- Bundle runtime dependencies, including `@modelcontextprotocol/sdk` and `zod`; externalize only Node built-ins and runtime programs such as `kimi`.
- Do not change Kimi auth, preflight, lifecycle, delegation, review, status normalization, or Web URL behavior.
- Do not change Kimi Code server or Codex plugin installation mechanics.
- Do not embed or commit real tokens, Authorization credentials, token-bearing URLs, repository absolute paths, or home-directory paths.
- Use plain semantic version `0.2.0` in committed package and plugin manifests; cachebuster suffixes are local reinstall state only.
- Use the official plugin cachebuster helper for development reinstall; never hand-edit marketplace JSON for cache invalidation.
- Do not publish an npm package, add an `npx` launcher, or create a remote marketplace in this change.

---

## File Map

- Create `src/plugin-entry.ts`: executable-only entry that invokes exported `main()` and reports startup failure on stderr.
- Modify `package.json`: add `0.2.0` release metadata, Node engine, esbuild, and separate core/plugin build scripts.
- Modify `pnpm-lock.yaml`: lock the direct esbuild development dependency and package metadata changes.
- Modify `plugins/kimi-delegate/.mcp.json`: launch the bundled server through `./mcp/server.mjs` with `"cwd": "."`.
- Create `plugins/kimi-delegate/mcp/server.mjs`: deterministic, tracked esbuild output containing the MCP runtime.
- Modify `test/plugin.test.ts`: validate relative launch config, artifact safety, metadata, and copied-directory MCP startup.
- Modify `plugins/kimi-delegate/.codex-plugin/plugin.json`: publish version, author, repository, homepage, license, and developer metadata.
- Create `LICENSE`: MIT license for the open-source repository.
- Modify `README.md`: document prerequisites, clone-based install, development updates, upgrades, and packaging troubleshooting.
- Modify `AGENTS.md`: record the portable bundle contract and the required regeneration/reinstall workflow.

### Task 1: Define And Build The Self-Contained Plugin Runtime

**Files:**
- Create: `src/plugin-entry.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `plugins/kimi-delegate/.mcp.json`
- Create: `plugins/kimi-delegate/mcp/server.mjs`
- Modify: `test/plugin.test.ts`

**Interfaces:**
- Consumes: exported `main(): Promise<void>` from `src/index.ts` and the existing MCP tool registration performed by `main`.
- Produces: executable `plugins/kimi-delegate/mcp/server.mjs`, launched as `node ./mcp/server.mjs` from the plugin root.

- [ ] **Step 1: Add failing relative-launch and copied-plugin smoke tests**

Replace `test/plugin.test.ts` with tests that preserve manifest validation and add the package contract:

```ts
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
});
```

- [ ] **Step 2: Run the focused tests and confirm the portability contract fails**

Run:

```bash
pnpm vitest run test/plugin.test.ts
```

Expected: FAIL because `.mcp.json` still contains the developer absolute path and `plugins/kimi-delegate/mcp/server.mjs` does not exist.

- [ ] **Step 3: Add the executable bundle entry**

Create `src/plugin-entry.ts`:

```ts
import { main } from './index.js';

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
```

Do not remove the direct-execution guard from `src/index.ts`; it remains useful for `node dist/index.js`. The dedicated entry exists so esbuild does not depend on that guard when producing the plugin artifact.

- [ ] **Step 4: Add deterministic core and plugin build scripts**

Update the root `package.json` scripts and dev dependencies to this shape while preserving `typecheck`, `test`, and `dev`:

```json
{
  "scripts": {
    "build:core": "tsc -p tsconfig.json",
    "build:plugin": "esbuild src/plugin-entry.ts --bundle --platform=node --format=esm --target=node20 --outfile=plugins/kimi-delegate/mcp/server.mjs",
    "build": "pnpm build:core && pnpm build:plugin",
    "typecheck": "tsc -p tsconfig.test.json --noEmit",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "esbuild": "^0.28.1",
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "vitest": "^2.1.0"
  }
}
```

Use pnpm to update the lockfile instead of editing dependency resolution records by hand:

```bash
pnpm add --save-dev esbuild@^0.28.1
```

Expected: `package.json` lists esbuild directly and `pnpm-lock.yaml` records it under the root importer.

- [ ] **Step 5: Switch the plugin launch config to its bundled artifact**

Change `plugins/kimi-delegate/.mcp.json` to use the bundled server and set Codex's working directory to the plugin root:

```json
{
  "args": ["./mcp/server.mjs"],
  "cwd": "."
}
```

Keep `command: "node"` and every existing environment default unchanged. The `"cwd": "."` value is required so Codex resolves the relative bundle path from the installed plugin root after copying the plugin into its cache.

- [ ] **Step 6: Generate the tracked plugin bundle**

Run:

```bash
pnpm build
```

Expected: TypeScript compilation succeeds and esbuild creates `plugins/kimi-delegate/mcp/server.mjs`. Do not add that path to `.gitignore`; the bundle must be committed.

- [ ] **Step 7: Run the focused tests and confirm copied-directory startup passes**

Run:

```bash
pnpm vitest run test/plugin.test.ts
```

Expected: PASS. The test must complete without contacting Kimi server, starting Kimi, or reading the real Kimi home/token.

- [ ] **Step 8: Commit the portable runtime slice**

```bash
git add package.json pnpm-lock.yaml src/plugin-entry.ts plugins/kimi-delegate/.mcp.json plugins/kimi-delegate/mcp/server.mjs test/plugin.test.ts
git commit -m "feat: package portable Kimi delegate runtime"
```

### Task 2: Enforce Artifact Safety And Release Metadata

**Files:**
- Modify: `test/plugin.test.ts`
- Modify: `package.json`
- Modify: `plugins/kimi-delegate/.codex-plugin/plugin.json`
- Modify: `src/index.ts`
- Create: `LICENSE`
- Regenerate: `plugins/kimi-delegate/mcp/server.mjs`

**Interfaces:**
- Consumes: `pluginRoot` and `bundlePath` constants introduced in Task 1.
- Produces: version `0.2.0` package/plugin identity and static safeguards against machine-specific paths or committed credentials.

- [ ] **Step 1: Add failing metadata and artifact-safety tests**

Append these tests inside the existing `describe('Codex plugin package', ...)` block in `test/plugin.test.ts`:

```ts
  it('contains portable release metadata', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'),
    );

    expect(packageJson).toMatchObject({
      version: '0.2.0',
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
      version: '0.2.0',
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
  });

  it('does not package machine-specific paths or credential values', () => {
    const configText = readFileSync(join(pluginRoot, '.mcp.json'), 'utf8');
    const bundleText = readFileSync(bundlePath, 'utf8');
    const packagedText = `${configText}\n${bundleText}`;

    expect(packagedText).not.toContain('/Users/ximenchuifeng');
    expect(packagedText).not.toContain(resolve('.'));
    expect(packagedText).not.toContain('Authorization: Bearer');
    expect(packagedText).not.toContain('#token=');

    const configuredToken = process.env.KIMI_SERVER_TOKEN?.trim();
    if (configuredToken) expect(packagedText).not.toContain(configuredToken);
  });
```

- [ ] **Step 2: Run the focused tests and confirm metadata fails**

Run:

```bash
pnpm vitest run test/plugin.test.ts
```

Expected: FAIL because package/plugin versions are still `0.1.0`, open-source metadata is absent, and `LICENSE` does not exist.

- [ ] **Step 3: Add root package release metadata**

Update the corresponding root `package.json` fields without setting `private` to false and without adding npm publication configuration:

```json
{
  "version": "0.2.0",
  "private": true,
  "author": "ximenchuifeng",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ximenchuifeng/codex-kimi-bridge.git"
  },
  "homepage": "https://github.com/ximenchuifeng/codex-kimi-bridge#readme",
  "engines": {
    "node": ">=20"
  }
}
```

Run `pnpm install --lockfile-only` after the edit so the root importer metadata stays synchronized.

- [ ] **Step 4: Add plugin release metadata without changing its identity**

Update the relevant fields in `plugins/kimi-delegate/.codex-plugin/plugin.json`:

```json
{
  "name": "kimi-delegate",
  "version": "0.2.0",
  "description": "Delegate implementation tasks from Codex to Kimi Code through a local MCP bridge.",
  "author": {
    "name": "ximenchuifeng",
    "url": "https://github.com/ximenchuifeng"
  },
  "homepage": "https://github.com/ximenchuifeng/codex-kimi-bridge#readme",
  "repository": "https://github.com/ximenchuifeng/codex-kimi-bridge",
  "license": "MIT"
}
```

Change `interface.developerName` from `Local` to `ximenchuifeng`. Preserve all plugin paths, descriptions, capabilities, and the existing default prompt.

- [ ] **Step 5: Keep the MCP implementation version aligned**

Change the server construction in `src/index.ts` to:

```ts
const server = new McpServer({ name: 'codex-kimi-bridge', version: '0.2.0' });
```

No other tool schema or handler code changes belong in this task.

- [ ] **Step 6: Add the MIT license**

Create repository-root `LICENSE` using the standard MIT License text, with this copyright line:

```text
Copyright (c) 2026 ximenchuifeng
```

The rest of the file must be the unmodified standard MIT grant and warranty disclaimer.

- [ ] **Step 7: Regenerate the bundle and run focused tests**

Run:

```bash
pnpm build
pnpm vitest run test/plugin.test.ts
```

Expected: both commands PASS; regenerated `server.mjs` contains the `0.2.0` MCP server identity but no forbidden path or credential value.

- [ ] **Step 8: Commit metadata and safety checks**

```bash
git add package.json pnpm-lock.yaml src/index.ts LICENSE plugins/kimi-delegate/.codex-plugin/plugin.json plugins/kimi-delegate/mcp/server.mjs test/plugin.test.ts
git commit -m "chore: prepare portable plugin release metadata"
```

### Task 3: Document Clone Installation And Developer Updates

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: tracked `plugins/kimi-delegate/mcp/server.mjs`, release version `0.2.0`, and local marketplace `codex-kimi-bridge-local` from Tasks 1-2.
- Produces: exact end-user installation and contributor regeneration/reinstall instructions.

- [ ] **Step 1: Rewrite the README opening around prerequisites and first installation**

Keep the existing product summary, then place these sections before the current daily Kimi usage material:

````markdown
## Prerequisites

- Git
- Node.js 20 or newer
- Codex with plugin support
- [Kimi Code](https://github.com/MoonshotAI/kimi-code), available as the `kimi` command

The plugin includes a tracked MCP server bundle. First-time installation does not require pnpm, dependency installation, or a TypeScript build.

## Install From Git

```bash
git clone https://github.com/ximenchuifeng/codex-kimi-bridge.git
cd codex-kimi-bridge
codex plugin marketplace add "$PWD"
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Open a new Codex task after installation so Codex loads the plugin tools. Confirm installation with:

```bash
codex plugin list | rg 'kimi-delegate|codex-kimi-bridge-local'
```
````

Do not tell first-time users to run `pnpm install` or `pnpm build`.

- [ ] **Step 2: Replace the old Development section with explicit contributor commands**

Add a `## Development` section containing:

````markdown
```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

`pnpm build` compiles `dist/` for development and regenerates the tracked `plugins/kimi-delegate/mcp/server.mjs`. Commit the bundle whenever source changes affect the MCP runtime.
````

Clearly label the validator path as a local contributor command. Do not present that machine-specific validator path as part of end-user installation or package runtime.

- [ ] **Step 3: Add local update and release version guidance**

Document the existing local-marketplace update flow:

````markdown
### Reinstall A Development Build

```bash
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/kimi-delegate
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

Open a new Codex task after reinstalling. The helper adds a local `+codex.<timestamp>` cachebuster; release commits keep the plugin version as plain semantic version `0.2.0`. Do not hand-edit `.agents/plugins/marketplace.json` to refresh an installed plugin.
````

Also explain that a user upgrading a cloned checkout pulls the desired release and reinstalls the same plugin; they do not re-add an already configured marketplace.

- [ ] **Step 4: Add packaging troubleshooting**

Add concise troubleshooting entries with exact remedies:

```markdown
### Plugin MCP Server Does Not Start

- Confirm `node --version` reports Node.js 20 or newer.
- Confirm `plugins/kimi-delegate/mcp/server.mjs` exists in the checkout.
- For a source checkout modified locally, run `pnpm install && pnpm build`, then reinstall the plugin with the cachebuster flow.
- After reinstalling, open a new Codex task so its MCP tool list refreshes.
```

Keep Kimi server/auth troubleshooting separate because MCP package startup does not require a live Kimi server.

- [ ] **Step 5: Update AGENTS.md for future maintainers**

Replace the absolute launch command under `Current Plugin State` with:

```text
node ./mcp/server.mjs
```

Record all of these rules:

```markdown
- `plugins/kimi-delegate/mcp/server.mjs` is a tracked generated artifact.
- Source changes affecting MCP runtime require `pnpm build` and committing the regenerated bundle.
- Fresh clone installation does not require pnpm because the bundle is tracked.
- Development reinstalls use `update_plugin_cachebuster.py`; release manifests use plain semantic versions.
```

Remove portable packaging from `Good Next Tasks` because this plan completes it. Do not remove the recommendation to dogfood the bridge on real repositories.

- [ ] **Step 6: Review documentation commands for audience correctness**

Run:

```bash
rg -n '/Users/ximenchuifeng/Coding/codex-kimi-bridge/dist/index.js|\.\./\.\./dist/index.js' README.md AGENTS.md plugins/kimi-delegate/.mcp.json
rg -n 'Install From Git|Reinstall A Development Build|server.mjs|Node.js 20|cachebuster' README.md AGENTS.md
```

Expected: first command returns no matches; second command shows the new installation, bundle, Node, and cachebuster guidance.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md AGENTS.md
git commit -m "docs: explain portable plugin installation"
```

### Task 4: Verify Reproducibility, Compatibility, And Package Completeness

**Files:**
- Regenerate if needed: `plugins/kimi-delegate/mcp/server.mjs`
- No source changes expected unless verification identifies a defect.

**Interfaces:**
- Consumes: all artifacts from Tasks 1-3.
- Produces: fresh evidence that the bundle is deterministic, the plugin validates, all Bridge tests pass, and only intended files changed.

- [ ] **Step 1: Run the complete automated verification suite**

Run in this order:

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected: all Vitest files pass, typecheck exits 0, TypeScript/esbuild build exits 0, and plugin validation prints `Plugin validation passed`.

- [ ] **Step 2: Prove the plugin bundle build is deterministic**

Run:

```bash
cp plugins/kimi-delegate/mcp/server.mjs /tmp/kimi-delegate-server.before.mjs
pnpm build:plugin
cmp /tmp/kimi-delegate-server.before.mjs plugins/kimi-delegate/mcp/server.mjs
rm /tmp/kimi-delegate-server.before.mjs
git diff --exit-code -- plugins/kimi-delegate/mcp/server.mjs
```

Expected: `cmp` and `git diff --exit-code` both exit 0. If either fails, identify and remove nondeterministic output before continuing.

- [ ] **Step 3: Run final static safety and identity checks**

Run:

```bash
rg -n '/Users/ximenchuifeng|Authorization: Bearer|#token=' plugins/kimi-delegate/.mcp.json plugins/kimi-delegate/mcp/server.mjs
node -e "const p=require('./package.json'); if(p.version!=='0.2.0'||p.engines.node!=='>=20') process.exit(1)"
node -e "const fs=require('node:fs'); const p=JSON.parse(fs.readFileSync('plugins/kimi-delegate/.codex-plugin/plugin.json','utf8')); if(p.name!=='kimi-delegate'||p.version!=='0.2.0') process.exit(1)"
```

Expected: `rg` returns no matches; both Node metadata assertions exit 0.

- [ ] **Step 4: Inspect the final diff and commit any verification-only correction**

Run:

```bash
git status --short
git diff --check
git diff --stat HEAD~3..HEAD
git log --oneline -5
```

Expected: no uncommitted changes, no whitespace errors, and the recent commits correspond only to portable runtime, release metadata, and documentation. If verification required a correction, commit only that correction with a focused message before rerunning Steps 1-3.

### Task 5: Codex-Only Local Reinstall And Post-Install Smoke

**Files:**
- Temporarily modified by helper: `plugins/kimi-delegate/.codex-plugin/plugin.json`
- No release source changes should remain after restoration.

**Interfaces:**
- Consumes: Codex-reviewed implementation and tracked `server.mjs` from Tasks 1-4.
- Produces: an installed cache copy using the self-contained runtime and end-to-end status/no-change delegate evidence.

This task is a rollout checkpoint for the controlling Codex after Kimi returns its handoff. Kimi must stop after Task 4 and must not perform the local Codex reinstall or post-install delegate smoke.

- [ ] **Step 1: Codex reviews Kimi handoff and diffs before installation**

Codex must inspect every changed source, test, generated bundle, manifest, lockfile, and documentation file. Codex independently reruns Task 4 verification before accepting the implementation.

- [ ] **Step 2: Codex applies the official local cachebuster and reinstalls**

Run:

```bash
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py plugins/kimi-delegate
codex plugin add kimi-delegate@codex-kimi-bridge-local
codex plugin list | rg 'kimi-delegate|codex-kimi-bridge-local'
```

Expected: the installed plugin is enabled with base version `0.2.0` plus one local `+codex.<timestamp>` suffix.

- [ ] **Step 3: Restore the committed release manifest after installation**

Use `apply_patch` to restore only `plugins/kimi-delegate/.codex-plugin/plugin.json` version from the generated cachebuster value to:

```json
"version": "0.2.0"
```

Do not use `git checkout`, `git restore`, or any command that could discard unrelated work. Confirm `git diff -- plugins/kimi-delegate/.codex-plugin/plugin.json` is empty afterward.

- [ ] **Step 4: User opens a new Codex task and Codex runs packaged-plugin smoke**

In the new task, call `kimi_bridge_status` and confirm the tool loads from the installed plugin and returns a valid Bridge status. Then use `kimi_delegate_and_wait` for a stable-title, no-file-change task with cwd `/Users/ximenchuifeng/Coding/codex-kimi-bridge`; require Kimi only to inspect repository status and report it without modifying files.

Expected: status tool responds, delegate reaches `idle`, a `reviewPackage` is present, the stable-title dedupe guard finds only one matching session, and no repository file changes are introduced.

- [ ] **Step 5: Codex records rollout evidence and decides merge/push**

Report installed version, status result, no-change session ID/Web URL, dedupe result, test totals, and clean Git status. Only after these checks pass should Codex merge if needed and push `main`.
