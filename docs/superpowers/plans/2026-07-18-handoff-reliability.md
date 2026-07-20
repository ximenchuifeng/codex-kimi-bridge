# Handoff Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Kimi handoff select the real final assistant report and include committed Git evidence even when Kimi leaves a clean working tree.

**Architecture:** Add one shared message-selection module and one local read-only Git inspector. Capture a Git baseline before new session creation, store it in namespaced Kimi metadata, then combine the baseline-to-HEAD committed range with Kimi's existing working-tree status in a structured and backward-compatible handoff.

**Tech Stack:** TypeScript 5.5, Node.js 20 `child_process`, Vitest, Kimi local HTTP API, MCP SDK, pnpm, esbuild.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-18-handoff-reliability-design.md`.
- Use TDD for every behavior change: failing focused test, minimal implementation, passing focused test.
- The Bridge may execute only read-only Git commands through argument arrays; never invoke a shell or mutate a repository.
- Do not modify Kimi Code server or Codex plugin installation mechanics.
- Do not fabricate a baseline for existing sessions, supplied `sessionId` values, deduped sessions, or continued sessions.
- Do not expose tokens in metadata, messages, diagnostics, errors, or URLs.
- Preserve existing tool fields; all new response fields are additive.
- Do not remove or overwrite pre-existing user changes.
- Release the plugin and package as `0.3.0` and regenerate the tracked bundle.

---

### Task 1: Shared Latest-Message Selection

**Files:**
- Create: `src/messages.ts`
- Create: `test/messages.test.ts`
- Modify: `src/handoff.ts`
- Modify: `src/tools.ts`
- Modify: `test/handoff.test.ts`
- Modify: `test/tools.test.ts`

**Interfaces:**
- Produces: `sanitizeDiagnosticText(value, token)`, `isInternalMessage(content)`, and `selectLatestMeaningfulMessage(messages, role, token, truncateAt?)` in `src/messages.ts`.
- Consumes: Kimi messages in newest-first API order.
- Changes: `BuildHandoffInput` gains `serverToken?: string`; `buildHandoff` uses the shared selector.

- [ ] **Step 1: Write failing shared-selector tests**

Create `test/messages.test.ts` with table-driven coverage equivalent to:

```ts
import { describe, expect, it } from 'vitest';
import { selectLatestMeaningfulMessage } from '../src/messages.js';

describe('selectLatestMeaningfulMessage', () => {
  it('selects the first meaningful assistant message from newest-first input', () => {
    const messages = [
      { role: 'assistant', content: 'new final report' },
      { role: 'tool', content: '' },
      { role: 'assistant', content: '   ' },
      { role: 'assistant', content: 'old report' },
    ];
    expect(selectLatestMeaningfulMessage(messages, 'assistant')).toBe('new final report');
  });

  it('skips internal messages and redacts the configured token', () => {
    const messages = [
      { role: 'assistant', content: '<system-reminder>ignore me</system-reminder>' },
      { role: 'assistant', content: 'finished with secret-token' },
    ];
    expect(selectLatestMeaningfulMessage(messages, 'assistant', 'secret-token'))
      .toBe('finished with [redacted]');
  });

  it('returns undefined when no meaningful message exists', () => {
    expect(selectLatestMeaningfulMessage([
      { role: 'assistant', content: '' },
      { role: 'user', content: 'not an assistant result' },
    ], 'assistant')).toBeUndefined();
  });
});
```

Add a regression test to `test/handoff.test.ts` using a newest-first full assistant report followed by an older empty assistant message. Add a recent-session summary test proving it selects the same message.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm vitest run test/messages.test.ts test/handoff.test.ts test/tools.test.ts
```

Expected: FAIL because `src/messages.ts` does not exist and current handoff selection returns the older empty message.

- [ ] **Step 3: Implement the shared message module**

Create `src/messages.ts` with these exports and semantics:

```ts
export interface TextMessage {
  role: string;
  content: string;
}

export function sanitizeDiagnosticText(value: string, token?: string): string;
export function isInternalMessage(content: string): boolean;
export function selectLatestMeaningfulMessage(
  messages: readonly TextMessage[],
  role: string,
  token?: string,
  truncateAt?: number,
): string | undefined;
```

Move the existing URL-token redaction, configured-token redaction, and internal-message predicates from `src/tools.ts` into this module. `selectLatestMeaningfulMessage` must iterate from index `0` upward, trim before emptiness checks, skip internal messages, sanitize before returning, and append `...` only when `truncateAt` is exceeded.

Update `buildHandoff`:

```ts
const finalMessage = selectLatestMeaningfulMessage(
  input.messages,
  'assistant',
  input.serverToken,
) ?? '';
```

Update `buildRecentSessionSummary` to select the latest user and assistant messages through the same helper with the existing `MESSAGE_TRUNCATION_LIMIT`.

- [ ] **Step 4: Run focused tests and verify success**

Run:

```bash
pnpm vitest run test/messages.test.ts test/handoff.test.ts test/tools.test.ts
```

Expected: PASS, including the newest-first regression and token-redaction cases.

- [ ] **Step 5: Commit the message fix**

```bash
git add src/messages.ts src/handoff.ts src/tools.ts test/messages.test.ts test/handoff.test.ts test/tools.test.ts
git commit -m "fix: select latest meaningful Kimi handoff message"
```

---

### Task 2: Read-Only Git Baseline And Range Inspector

**Files:**
- Create: `src/git.ts`
- Create: `test/git.test.ts`
- Modify: `src/handoff.ts`

**Interfaces:**
- Produces: `GitInspector`, `NodeGitInspector`, `GitBaseline`, `BaselineCaptureResult`, and `CommittedChangeResult`.
- Produces in `src/handoff.ts`: `CommitSummary`, `HandoffChangeSet`, and optional `FileDiff.source`.
- Consumes: an absolute or caller-provided workspace `cwd`, and an optional validated baseline commit.

- [ ] **Step 1: Add failing temporary-repository tests**

Create `test/git.test.ts`. Use `mkdtemp`, `execFile`, and local per-test Git identity (`git config user.name Test`, `git config user.email test@example.com`). Cover:

```ts
const inspector = new NodeGitInspector({ timeoutMs: 5_000, maxOutputBytes: 1_048_576 });
const baseline = await inspector.captureBaseline(repo);
expect(baseline).toMatchObject({
  available: true,
  baseline: { schemaVersion: 1, baseCommit: expect.any(String), initialDirtyPaths: [] },
});

// After editing and committing "src/a b.ts":
const range = await inspector.collectCommittedChanges(repo, baseline.baseline);
expect(range.available).toBe(true);
expect(range.commits[0].subject).toBe('feat: change spaced file');
expect(range.changeSet.changedFiles).toEqual(['src/a b.ts']);
expect(range.changeSet.additions).toBeGreaterThan(0);
expect(range.changeSet.diffs[0]).toMatchObject({ path: 'src/a b.ts', source: 'committed' });
```

Also test: initial dirty paths, unchanged range, non-Git directory, repository without a commit, missing baseline, invalid object ID, baseline not ancestor of `HEAD`, and a filename containing shell metacharacters. Assert no filename is executed as a command. Test bounded patch behavior by configuring a small `maxOutputBytes` and asserting the path appears in `truncatedPaths` rather than returning a falsely complete patch.

- [ ] **Step 2: Run the Git tests and verify failure**

Run:

```bash
pnpm vitest run test/git.test.ts
```

Expected: FAIL because the Git inspector and handoff change-set types do not exist.

- [ ] **Step 3: Add the handoff evidence types**

Extend `src/handoff.ts` with:

```ts
export type DiffSource = 'committed' | 'working_tree';

export interface FileDiff {
  path: string;
  diff: string;
  source?: DiffSource;
}

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
}

export interface HandoffChangeSet {
  available: boolean;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
  truncatedPaths: string[];
  unavailableReason?: string;
}
```

Keep `source` optional so existing callers constructing `{ path, diff }` remain source-compatible.

- [ ] **Step 4: Implement `src/git.ts` with argument-array Git reads**

Implement these public contracts:

```ts
export interface GitBaseline {
  schemaVersion: 1;
  baseCommit: string;
  baseBranch?: string;
  initialDirtyPaths: string[];
}

export type BaselineCaptureResult =
  | { available: true; baseline: GitBaseline }
  | { available: false; unavailableReason: 'not_a_git_repository' | 'head_unavailable' | 'git_command_failed' };

export interface CommittedChangeResult {
  baseCommit?: string;
  headCommit?: string;
  commits: CommitSummary[];
  changeSet: HandoffChangeSet;
}

export interface GitInspector {
  captureBaseline(cwd: string): Promise<BaselineCaptureResult>;
  collectCommittedChanges(cwd: string, baseline?: GitBaseline): Promise<CommittedChangeResult>;
}

export class NodeGitInspector implements GitInspector {
  constructor(options?: { timeoutMs?: number; maxOutputBytes?: number });
}
```

Use only `execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer, encoding: 'buffer' })` or an equivalent no-shell argument API. Validate stored object IDs with `/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/`. Use NUL-delimited formats for commit and path parsing. Before range inspection, run `merge-base --is-ancestor <base> HEAD`; map exit code `1` to `base_not_ancestor`.

Stable unavailable reasons are exactly:

```ts
type CommittedUnavailableReason =
  | 'baseline_unavailable'
  | 'not_a_git_repository'
  | 'head_unavailable'
  | 'base_not_ancestor'
  | 'git_command_failed';
```

For patch overflow, retain commit/file/stat evidence, omit only the incomplete patch, and add its path to `truncatedPaths`. Never return partial patch text as complete.

- [ ] **Step 5: Run Git tests and the typechecker**

Run:

```bash
pnpm vitest run test/git.test.ts
pnpm typecheck
```

Expected: PASS. Temporary repositories are removed in test cleanup even after failures.

- [ ] **Step 6: Commit the Git inspector**

```bash
git add src/git.ts src/handoff.ts test/git.test.ts
git commit -m "feat: inspect committed Kimi changes from Git baseline"
```

---

### Task 3: Persist Baseline On New Kimi Sessions

**Files:**
- Create: `src/baseline-store.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/kimi/client.ts`
- Modify: `src/kimi/types.ts`
- Modify: `src/tools.ts`
- Modify: `test/baseline-store.test.ts`
- Modify: `test/client.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/fixtures/fake-kimi-server.ts`
- Modify: `test/fixtures/run-review-package.ts`
- Modify: `test/integration.test.ts`
- Modify: `test/preflight.test.ts`
- Modify: `test/tools.test.ts`

**Interfaces:**
- Consumes: `GitInspector.captureBaseline(cwd)` from Task 2.
- Produces: `BaselineStore` abstraction, `FileBaselineStore`, `InMemoryBaselineStore`, `KIMI_BRIDGE_STATE_DIR` config, and the `codex_kimi_bridge` wire metadata object.
- Changes: `ToolDeps` gains optional `gitInspector?: GitInspector` and `baselineStore?: BaselineStore`; production defaults to `NodeGitInspector` and a `FileBaselineStore` under `KIMI_BRIDGE_STATE_DIR`.

- [ ] **Step 1: Write failing client, store, and delegation tests**

Add a client test asserting:

```ts
await client.createSession({
  cwd: '/repo',
  title: 'task',
  metadata: { codex_kimi_bridge: { schema_version: 1, base_commit: 'a'.repeat(40) } },
});

expect(http.post).toHaveBeenCalledWith('/sessions', {
  title: 'task',
  metadata: {
    codex_kimi_bridge: { schema_version: 1, base_commit: 'a'.repeat(40) },
    cwd: '/repo',
  },
});
```

Add `test/baseline-store.test.ts` for `FileBaselineStore` proving:

- Save/load round-trips a baseline.
- Unknown sessions return `undefined`.
- Invalid file contents are rejected.
- Different sessions are isolated in separate files.
- Baselines are isolated by server URL.
- Files are written atomically.

Add tool tests with an injected fake `GitInspector` and `BaselineStore` proving:

- A newly created session saves the baseline to the store after `createSession` returns.
- Session metadata stripped by a real-shaped server is recovered from the local store.
- A missing store entry falls back to session metadata.
- A failed store write reports `baselineStored: false` and a safe `baselineStoreError` without blocking Kimi execution.
- Passing `sessionId` skips both baseline capture and store write.
- A dedupe match skips new baseline capture.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run test/client.test.ts test/tools.test.ts
```

Expected: FAIL because session creation cannot accept metadata and handlers do not capture a baseline.

- [ ] **Step 3: Extend session creation metadata safely**

Update the client input and merge order:

```ts
export interface CreateSessionInput {
  cwd: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

metadata: {
  ...input.metadata,
  cwd: input.cwd,
}
```

The final `cwd` assignment is intentional: arbitrary metadata must not overwrite the requested workspace.

Add conversion helpers in `src/tools.ts`:

```ts
function baselineMetadata(baseline: GitBaseline): Record<string, unknown> {
  return {
    codex_kimi_bridge: {
      schema_version: 1,
      base_commit: baseline.baseCommit,
      ...(baseline.baseBranch ? { base_branch: baseline.baseBranch } : {}),
      initial_dirty_paths: baseline.initialDirtyPaths,
    },
  };
}
```

In `kimi_delegate_task`, call `captureBaseline` only in the branch that creates a new session. Pass metadata only for an available baseline. After `createSession` returns, save the baseline to the injected `BaselineStore`. Keep supplied-session behavior unchanged.

In `kimi_get_handoff`, load the baseline from the store first and fall back to session metadata only when the store has no entry.

- [ ] **Step 4: Update the fake server and run focused tests**

Make the fake server strip posted session metadata down to only `cwd`, matching real Kimi 0.27 behavior. Add a cross-process persistence test that delegates in one process and fetches `review_package` from a fresh subprocess sharing only the state directory. Run:

```bash
pnpm vitest run test/client.test.ts test/baseline-store.test.ts test/config.test.ts test/tools.test.ts test/integration.test.ts
```

Expected: PASS, including existing delegation and integration behavior.

- [ ] **Step 5: Commit baseline persistence**

```bash
git add src/baseline-store.ts src/config.ts src/index.ts src/kimi/client.ts src/kimi/types.ts src/tools.ts test/baseline-store.test.ts test/client.test.ts test/config.test.ts test/fixtures/fake-kimi-server.ts test/fixtures/run-review-package.ts test/integration.test.ts test/preflight.test.ts test/tools.test.ts
git commit -m "feat: persist delegation Git baseline in local durable store"
```

---

### Task 4: Enrich Handoff And Review Packages

**Files:**
- Modify: `src/git.ts`
- Modify: `src/handoff.ts`
- Modify: `src/tools.ts`
- Modify: `test/handoff.test.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/integration.test.ts`

**Interfaces:**
- Consumes: session `metadata.codex_kimi_bridge`, `GitInspector.collectCommittedChanges`, and existing Kimi working-tree APIs.
- Produces: enriched `KimiHandoff`, aggregate compatibility fields, and structured review-package stats.

- [ ] **Step 1: Write failing aggregation and handler tests**

Extend `test/handoff.test.ts` with committed-only, working-tree-only, and mixed cases. The mixed case must assert:

```ts
expect(result.changedFiles).toEqual(['committed.ts', 'same.ts', 'working.ts']);
expect(result.additions).toBe(committed.additions + working.additions);
expect(result.deletions).toBe(committed.deletions + working.deletions);
expect(result.diffs.filter((item) => item.path === 'same.ts')).toEqual([
  expect.objectContaining({ source: 'committed' }),
  expect.objectContaining({ source: 'working_tree' }),
]);
```

Add handler tests proving:

- Stored snake-case metadata is validated and converted to `GitBaseline`.
- A committed-only session with clean `fs:git_status` still returns the committed file at top level.
- A legacy session calls the inspector without a fabricated baseline and returns `baseline_unavailable`.
- `buildHandoff` receives `serverToken`, so final-message redaction applies.
- `kimi_review_package` and embedded `kimi_delegate_and_wait.reviewPackage` expose the same structured handoff.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run test/handoff.test.ts test/tools.test.ts test/integration.test.ts
```

Expected: FAIL because the public handoff has no structured committed or working-tree fields.

- [ ] **Step 3: Implement metadata validation and working-tree change-set creation**

Parse metadata defensively. Accept only:

- `schema_version === 1`
- a 40- or 64-character hexadecimal `base_commit`
- optional string `base_branch`
- `initial_dirty_paths` as an array of strings

Malformed or absent data becomes `undefined`; it never throws and never uses current `HEAD` as a substitute.

Convert the existing Kimi Git response to:

```ts
const workingTreeChanges: HandoffChangeSet = {
  available: true,
  changedFiles,
  additions: gitStatus.additions,
  deletions: gitStatus.deletions,
  diffs: diffs.map((item) => ({ ...item, source: 'working_tree' })),
  truncatedPaths: [],
};
```

- [ ] **Step 4: Extend `buildHandoff` and tool orchestration**

Extend `BuildHandoffInput` and `KimiHandoff` exactly as designed:

```ts
export interface BuildHandoffInput {
  messages: readonly HandoffMessage[];
  waitStatus: string;
  serverToken?: string;
  baseCommit?: string;
  headCommit?: string;
  commits: readonly CommitSummary[];
  initialDirtyPaths: readonly string[];
  committedChanges: HandoffChangeSet;
  workingTreeChanges: HandoffChangeSet;
}
```

Build top-level fields as a sorted set union and arithmetic sum. Concatenate committed diffs before working-tree diffs, sorting each source by path for deterministic output.

In `kimi_get_handoff`:

1. Fetch messages, Kimi working-tree status, and session.
2. Expand working-tree paths and fetch their Kimi diffs.
3. Parse the stored baseline.
4. Call `collectCommittedChanges(session.metadata.cwd, baseline)`.
5. Build the structured and aggregate handoff.

Do not allow committed inspection failure to discard successfully collected working-tree evidence.

- [ ] **Step 5: Enrich review-package stats and checklist**

Preserve the existing total fields and add source details:

```ts
diffStats: {
  filesChanged: number;
  additions: number;
  deletions: number;
  diffsWithContent: number;
  committed: {
    available: boolean;
    filesChanged: number;
    additions: number;
    deletions: number;
    commits: number;
    unavailableReason?: string;
  };
  workingTree: {
    available: boolean;
    filesChanged: number;
    additions: number;
    deletions: number;
  };
}
```

Add checklist entries requiring Codex to review committed evidence, working-tree evidence, initial dirty paths, and any unavailable/truncated evidence. An unavailable committed range must not be described as zero committed changes.

- [ ] **Step 6: Run focused tests and full tests**

Run:

```bash
pnpm vitest run test/handoff.test.ts test/tools.test.ts test/integration.test.ts
pnpm test
pnpm typecheck
```

Expected: all test files pass and TypeScript reports no errors.

- [ ] **Step 7: Commit enriched handoff behavior**

```bash
git add src/git.ts src/handoff.ts src/tools.ts test/handoff.test.ts test/tools.test.ts test/integration.test.ts
git commit -m "feat: include committed evidence in Kimi handoffs"
```

---

### Task 5: Documentation, Skill Guidance, And Version 0.3.0

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/prompts/kimi-delegate-workflow.md`
- Modify: `plugins/kimi-delegate/skills/kimi-delegate/SKILL.md`
- Modify: `package.json`
- Modify: `plugins/kimi-delegate/.codex-plugin/plugin.json`
- Modify: `src/index.ts`
- Modify: `test/plugin.test.ts`
- Modify: `test/index.test.ts`

**Interfaces:**
- Consumes: the final response shape from Task 4.
- Produces: user and agent guidance that treats committed and working-tree evidence separately; synchronized `0.3.0` version metadata.

- [ ] **Step 1: Add failing version and documentation assertions**

Update plugin/index tests to expect `0.3.0` consistently in `package.json`, plugin manifest, MCP server identity, and generated bundle after build. Add narrow text assertions that README and plugin skill mention `committedChanges`, `workingTreeChanges`, and `initialDirtyPaths`.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm vitest run test/plugin.test.ts test/index.test.ts
```

Expected: FAIL while source and manifests still report `0.2.0` and documentation lacks the new review instructions.

- [ ] **Step 3: Update documentation and workflow guidance**

Document these exact operational rules:

- A clean working tree does not prove Kimi made no changes; inspect `committedChanges`.
- `workingTreeChanges` may include pre-existing user work listed by `initialDirtyPaths`.
- `available: false` means evidence is unavailable, not empty.
- Old sessions may require direct `git log`/`git diff` review because they lack a baseline.
- Codex must review both change sets before acceptance and use `kimi_continue_task` for fixes.

Update the reusable prompt template and installed skill review loop to request a concrete final report from Kimi and to inspect both structured evidence sources.

- [ ] **Step 4: Synchronize version `0.3.0`**

Set:

```json
// package.json
"version": "0.3.0"

// plugins/kimi-delegate/.codex-plugin/plugin.json
"version": "0.3.0"
```

Set the MCP server identity in `src/index.ts` to `0.3.0`. Do not alter marketplace installation policy or `.mcp.json` launch mechanics.

- [ ] **Step 5: Run focused tests and commit docs/version source**

Run:

```bash
pnpm vitest run test/plugin.test.ts test/index.test.ts
```

Expected: PASS for source/manifests/documentation assertions. Then commit:

```bash
git add README.md AGENTS.md docs/prompts/kimi-delegate-workflow.md plugins/kimi-delegate/skills/kimi-delegate/SKILL.md package.json plugins/kimi-delegate/.codex-plugin/plugin.json src/index.ts test/plugin.test.ts test/index.test.ts
git commit -m "docs: release reliable handoffs in plugin 0.3.0"
```

---

### Task 6: Bundle, Full Verification, And Kimi Handoff

**Files:**
- Modify (generated): `plugins/kimi-delegate/mcp/server.mjs`
- Modify only if formatting requires it: files changed in Tasks 1-5

**Interfaces:**
- Consumes: all implementation and documentation tasks.
- Produces: a portable validated plugin bundle and complete Kimi handoff for Codex review.

- [ ] **Step 1: Run formatting-neutral diff checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intended implementation, test, documentation, manifest, and generated files are present.

- [ ] **Step 2: Run the complete verification suite**

```bash
pnpm test
pnpm typecheck
pnpm build
python3 /Users/ximenchuifeng/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/kimi-delegate
```

Expected:

- All Vitest files and tests pass.
- TypeScript typecheck passes.
- Core and plugin bundle builds pass.
- Plugin validation prints `Plugin validation passed`.

- [ ] **Step 3: Verify bundle portability and secret safety**

```bash
test -s plugins/kimi-delegate/mcp/server.mjs
rg -n 'KIMI_SERVER_TOKEN|Authorization|Bearer ' plugins/kimi-delegate/mcp/server.mjs plugins/kimi-delegate/.mcp.json README.md
```

Expected: bundle exists; matches are only configuration names or implementation literals, never a real token value. Inspect suspicious output before proceeding.

- [ ] **Step 4: Commit the regenerated bundle**

```bash
git add plugins/kimi-delegate/mcp/server.mjs
git commit -m "build: regenerate Kimi delegate 0.3.0 bundle"
```

- [ ] **Step 5: Return the implementation handoff**

Return all of the following to Codex:

1. Commit list created during this plan.
2. Modified-file list.
3. Exact verification counts and results.
4. The final `git status --short` output.
5. Any plan deviations and why.
6. Known risks, especially Git output truncation and legacy sessions.
7. Confirmation that no plugin reinstall, Codex restart, real-server dogfood, push, or Kimi Code server modification was performed.
8. Wait for Codex review.

---

## Codex Post-Implementation Review And Dogfood

These are Codex-owned steps after Kimi returns; Kimi must not perform them during implementation.

1. Read Kimi's handoff and every changed-file diff.
2. Review each commit and compare the implementation with the design and this plan.
3. Independently run `pnpm test`, `pnpm typecheck`, `pnpm build`, and plugin validation.
4. Reinstall with `codex plugin add kimi-delegate@codex-kimi-bridge-local` using the project cachebuster workflow.
5. Restart Codex or open a new task so MCP definitions refresh.
6. In a disposable temporary Git repository, create one baseline commit and delegate Kimi to edit and commit one file.
7. Verify non-empty `finalMessage`, correct `baseCommit` and `headCommit`, one commit summary, committed-only file evidence, empty working-tree evidence, aggregate compatibility fields, and dedupe reuse.
8. Remove the disposable repository. Do not add dogfood commits to this project.
9. Send precise fixes with `kimi_continue_task` if any acceptance criterion fails; otherwise accept and push only when requested.

