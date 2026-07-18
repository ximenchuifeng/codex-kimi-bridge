# Portable Plugin Packaging Design

## Summary

The current `kimi-delegate` plugin starts its MCP server through an absolute path to one developer checkout:

```text
/Users/ximenchuifeng/Coding/codex-kimi-bridge/dist/index.js
```

That path works only on the original machine. Codex copies a local plugin into its plugin cache when installing it, so replacing the absolute path with `../../dist/index.js` would still fail after installation: the cached plugin no longer sits beside the repository `dist` directory.

This change makes the plugin self-contained. The repository build bundles the MCP server and its runtime dependencies into `plugins/kimi-delegate/mcp/server.mjs`. The plugin launches that artifact with a plugin-root-relative path. A user can clone the repository, register its marketplace, and install the plugin without editing paths, installing pnpm dependencies, or building TypeScript.

## Goals

- Remove the developer-specific absolute MCP server path.
- Make the installed plugin independent of the source checkout, `dist`, and `node_modules`.
- Let a new user install directly from a Git clone containing the tracked bundle.
- Keep developer builds deterministic and able to regenerate the tracked bundle.
- Prove portability by running the plugin from a temporary copied directory and unrelated working directory.
- Preserve the current plugin ID, marketplace name, MCP tool contracts, Kimi authentication, and preflight behavior.
- Add the minimum open-source metadata needed for a usable public repository.

## Non-Goals

- Publishing an npm package.
- Supporting `npx` as the plugin launch command.
- Hosting a remote marketplace.
- Renaming `kimi-delegate@codex-kimi-bridge-local`.
- Automatically downloading or installing Kimi Code.
- Changing Kimi server, authentication, status normalization, delegation, or review behavior.
- Adding a graphical installer.
- Supporting installation without Git or Node.js.

## Supported Environment

- Node.js 20 or newer.
- Git for cloning the repository.
- Codex with local marketplace and plugin commands.
- Kimi Code remains an independent runtime prerequisite.

The generated MCP bundle targets Node.js 20 and uses ESM.

## Architecture

### Source Entry

Add `src/plugin-entry.ts` as a small executable entry point. It imports `main` from `src/index.ts`, calls it once, writes an uncaught startup error to stderr, and exits non-zero.

`src/index.ts` remains the development/library entry and continues exporting `main` for tests and direct execution. The plugin bundle uses `plugin-entry.ts` so startup does not depend on the `import.meta.url === file://${process.argv[1]}` guard surviving bundling.

### Bundled Artifact

Use esbuild to bundle:

```text
src/plugin-entry.ts
  + Bridge source
  + @modelcontextprotocol/sdk
  + zod
  + required runtime dependencies
        |
        v
plugins/kimi-delegate/mcp/server.mjs
```

The artifact is:

- ESM.
- Targeted at Node.js 20.
- Self-contained except for Node built-ins and external programs intentionally launched at runtime, such as `kimi`.
- Checked into Git so end users do not need pnpm or a build step.
- Generated without source maps or timestamps so repeated builds are deterministic.

The build must not embed the repository path, a home-directory path, tokens, Authorization headers, or token-bearing URLs.

### Plugin MCP Configuration

Change `plugins/kimi-delegate/.mcp.json` to:

```json
{
  "mcpServers": {
    "kimi-delegate": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "env": {
        "KIMI_SERVER_URL": "http://127.0.0.1:58627",
        "KIMI_PERMISSION_MODE": "auto",
        "KIMI_THINKING": "high",
        "KIMI_AUTO_START": "true",
        "KIMI_COMMAND": "kimi",
        "KIMI_PREFLIGHT_CACHE_MS": "5000",
        "KIMI_CODE_HOME": "",
        "KIMI_SERVER_TOKEN": ""
      }
    }
  }
}
```

Codex resolves the relative argument from the installed plugin root. Therefore the same config works from the repository plugin directory and from the copied Codex cache directory.

## Build Commands

Add esbuild as a development dependency and define focused scripts:

```json
{
  "scripts": {
    "build:core": "tsc -p tsconfig.json",
    "build:plugin": "esbuild src/plugin-entry.ts --bundle --platform=node --format=esm --target=node20 --outfile=plugins/kimi-delegate/mcp/server.mjs",
    "build": "pnpm build:core && pnpm build:plugin"
  }
}
```

The exact command may add only deterministic flags required by the implementation. It must not externalize `@modelcontextprotocol/sdk` or `zod`.

`pnpm test` must exercise the tracked artifact. Full release verification runs `pnpm build` first and then checks that rebuilding does not leave an unexpected bundle diff.

## Version And Repository Metadata

Release the portable packaging as version `0.2.0` in both:

- Root `package.json`.
- `plugins/kimi-delegate/.codex-plugin/plugin.json`.

Keep the plugin name and marketplace name unchanged.

Add or normalize:

- Repository: `https://github.com/ximenchuifeng/codex-kimi-bridge`.
- Homepage: the repository URL or its README URL.
- License: MIT.
- Author/developer identity: `ximenchuifeng`.
- Root package `engines.node`: `>=20`.
- A repository-root `LICENSE` containing the MIT license.

The committed plugin version is plain `0.2.0`. Codex cachebuster suffixes are local development state and are generated only by the official `update_plugin_cachebuster.py` helper before reinstalling a development build.

## Installation Flows

### First Installation From Git

Document this flow for a machine that has not installed the repository marketplace:

```bash
git clone https://github.com/ximenchuifeng/codex-kimi-bridge.git
cd codex-kimi-bridge
codex plugin marketplace add "$PWD"
codex plugin add kimi-delegate@codex-kimi-bridge-local
```

The tracked bundle makes `pnpm install` and `pnpm build` unnecessary for this first-use flow.

After installation, the user opens a new Codex task so the MCP tool list is loaded from the installed plugin.

### Development Update

Document the contributor flow separately:

1. Install dependencies.
2. Modify source and tests.
3. Run `pnpm build` to regenerate core output and the tracked plugin bundle.
4. Run all verification commands.
5. Run the official plugin cachebuster helper.
6. Reinstall from `codex-kimi-bridge-local`.
7. Open a new Codex task.

Do not hand-edit `.agents/plugins/marketplace.json` during an update. Existing users do not re-add the marketplace unless it was removed from their Codex configuration.

### Release Update

Future published releases increment the normal semantic version. Cachebuster suffixes are not committed as release versions.

## Portability Verification

### Static Assertions

Tests must confirm:

- `.mcp.json` uses `node` plus `./mcp/server.mjs`.
- The referenced bundle exists under the plugin root.
- Neither `.mcp.json` nor the bundle contains `/Users/ximenchuifeng`, the current repository absolute path, `Authorization: Bearer`, `#token=`, or a real configured token value.
- The plugin manifest and marketplace still pass Codex validation.

Generic source strings used for token-redaction logic are allowed, but no credential value may be embedded.

### MCP Package Smoke Test

Add a test that:

1. Copies `plugins/kimi-delegate` to a temporary directory outside the repository.
2. Starts `node ./mcp/server.mjs` with the temporary plugin directory as the child process working directory.
3. Connects using the MCP SDK client and stdio transport.
4. Calls `listTools`.
5. Verifies the expected Bridge tool names are present, including `kimi_bridge_status`, `kimi_delegate_task`, `kimi_delegate_and_wait`, and `kimi_review_package`.
6. Closes the client and subprocess cleanly.

The smoke test must not invoke a Kimi tool, start Kimi server, require a token, or consume model quota. Listing tools only verifies that the packaged MCP server starts and registers its contract.

### Build Reproducibility

After `pnpm build`, verify that a second `pnpm build:plugin` produces no change to `plugins/kimi-delegate/mcp/server.mjs`.

The bundle is reviewed as a generated artifact. Source behavior remains reviewed through the TypeScript source and unit tests.

## Error Handling

- If Node.js is unavailable, Codex reports failure to launch the configured `node` command; README identifies Node 20+ as a prerequisite.
- If the bundle is missing or stale, build and portability tests fail before plugin installation is accepted.
- If Kimi is unavailable after the MCP server starts, existing preflight diagnostics remain responsible for explaining and optionally auto-starting Kimi.
- Installation documentation distinguishes first install, local development update, and future release update to avoid unnecessary marketplace changes.

## Security

- No build step reads Kimi token files.
- No environment-specific secret is passed to esbuild.
- `.mcp.json` keeps `KIMI_SERVER_TOKEN` empty.
- The tracked artifact is scanned for known absolute paths and credential-bearing patterns.
- Runtime token resolution order remains unchanged.
- The temporary portability test uses no real token and deletes only its own temporary copy.

## Documentation

Update `README.md` with:

- Prerequisites.
- First installation from Git.
- Kimi server setup.
- Development build and reinstall flow.
- Upgrade behavior.
- Troubleshooting for missing Node, missing bundle, and stale plugin cache.

Update `AGENTS.md` so future Codex tasks know:

- The plugin launches `./mcp/server.mjs`.
- Source changes require regenerating the tracked bundle.
- Development reinstalls use the official cachebuster helper.
- Release commits use plain semantic versions.

## Acceptance Criteria

1. No developer-specific absolute path remains in plugin launch configuration or bundle.
2. `.mcp.json` launches `node ./mcp/server.mjs`.
3. The tracked bundle starts from a copied temporary plugin directory with no repository `dist` or `node_modules` dependency.
4. MCP `listTools` from the copied plugin exposes the expected Bridge tools.
5. A fresh Git clone can be registered and installed without running pnpm or editing files.
6. Root package and plugin versions are `0.2.0` with MIT/repository/Node metadata.
7. The existing plugin ID and marketplace name remain unchanged.
8. Kimi auth, preflight, lifecycle, delegation, review, and Web URL behavior remain unchanged.
9. `pnpm test`, `pnpm typecheck`, `pnpm build`, and plugin validation pass.
10. Rebuilding the plugin bundle is deterministic and leaves no unexpected diff.
11. No real token, Authorization credential, or token-bearing URL is committed or emitted.
12. After cachebuster reinstall and Codex restart, `kimi_bridge_status` and a no-change delegate smoke pass using the packaged MCP server.

## Rollout

1. Kimi implements the package, tests, metadata, and documentation on a feature branch.
2. Codex reviews source changes and the generated bundle, then independently runs full verification.
3. Codex uses the official cachebuster helper and reinstalls the local plugin.
4. The user opens a new Codex task.
5. Codex verifies the loaded plugin path points to the cached self-contained bundle and runs status plus no-change delegate smoke.
6. Codex restores the source manifest to plain `0.2.0` if the local cachebuster helper modified it, keeping the installed cached version intact.
7. Codex merges and pushes the portable release after the post-install smoke passes.

Publishing through npm can be evaluated as a separate follow-up after the Git-clone installation path is dogfooded.
