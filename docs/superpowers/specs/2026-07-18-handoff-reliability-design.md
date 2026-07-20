# Handoff Reliability Design

## Summary

The bridge currently has two independent handoff reliability gaps:

1. Kimi returns session messages newest-first, but `buildHandoff` reverses the list and selects the first assistant message. An older empty assistant message can therefore replace Kimi's real final report with `finalMessage: ""`.
2. Handoff change discovery reads only Kimi's current working-tree Git status and per-file working-tree diffs. If Kimi commits its work before finishing, the working tree is clean and the handoff reports no changed files even though the session produced commits.

This change fixes message selection and adds a delegation-time Git baseline. Review packages will expose committed changes from that baseline to the current `HEAD` separately from current working-tree changes, while retaining useful aggregate compatibility fields.

## Goals

- Select the latest non-empty, non-internal assistant message as the handoff final message.
- Capture the repository commit at the start of a new delegated session.
- Preserve that baseline in Kimi session metadata so it survives Codex restarts and dedupe recovery.
- Report commits and committed file changes even when Kimi leaves a clean working tree.
- Keep committed changes and working-tree changes visibly separate.
- Keep existing top-level handoff fields useful for current consumers.
- Degrade explicitly for old sessions, non-Git workspaces, and invalid commit ancestry.
- Avoid changing Kimi Code server or Codex plugin installation mechanics.

## Non-Goals

- Attributing individual lines to Kimi versus pre-existing uncommitted user work.
- Snapshotting or restoring the user's working tree.
- Replacing Git with a Kimi server API.
- Modifying, rebasing, checking out, staging, or committing repository content.
- Automatically trusting Kimi's prose report instead of inspecting repository state.
- Backfilling an invented baseline for sessions created before this feature.
- Changing approval, question, abort, dedupe status, or wait semantics.

## Chosen Approach

The Bridge will capture Git baseline metadata locally before it creates a new Kimi session. It will store that metadata in the session resource and later use local, read-only Git commands to calculate the committed range.

This is preferred over two alternatives:

- Relying on Kimi's final prose report would fix neither missing nor inaccurate repository evidence.
- Adding commit-range endpoints to Kimi Code server would enlarge the change surface and couple the Bridge to a server modification that is not otherwise required.

Local Git inspection is already part of Codex review work. Keeping it in the Bridge makes the evidence structured and repeatable without giving the Bridge permission to mutate the repository.

## Session Baseline Metadata

Before creating a new Kimi session, the Bridge captures a baseline from the requested `cwd`:

```ts
export interface GitBaseline {
  schemaVersion: 1;
  baseCommit: string;
  baseBranch?: string;
  initialDirtyPaths: string[];
}
```

The baseline is stored in a Bridge-owned local durable store because real Kimi 0.27 servers strip arbitrary session metadata. The store uses one file per session under `KIMI_BRIDGE_STATE_DIR` (default `~/.codex-kimi-bridge/state`), keyed by server identity and session id. Files contain no token or credential and are written atomically.

For backward compatibility, the Bridge still sends the baseline under a namespaced metadata key:

```json
{
  "cwd": "/absolute/workspace",
  "codex_kimi_bridge": {
    "schema_version": 1,
    "base_commit": "<40-or-64-character-object-id>",
    "base_branch": "main",
    "initial_dirty_paths": ["path/that/was/already-dirty.ts"]
  }
}
```

At handoff time the Bridge loads the baseline from the local store first and falls back to parsing session metadata only when the store has no entry.

Rules:

- Baseline capture happens before `POST /sessions` and before Kimi receives the delegation prompt.
- The baseline is saved to the local store after `createSession` returns a `sessionId` and before the delegation prompt is submitted.
- A Git repository with no commit yet has no usable `baseCommit`; delegation still proceeds with an explicit baseline-unavailable state.
- Failure to inspect Git must not prevent delegation.
- Failure to write the local store must not block Kimi execution; the delegate result reports `baselineStored: false` with a safe error.
- `initialDirtyPaths` is diagnostic evidence only. Version 1 does not subtract the original uncommitted diff from later working-tree changes.
- When the caller supplies `sessionId`, the Bridge uses that session's existing store entry or metadata. It does not capture and attach a new baseline.
- A deduped or continued session keeps its original baseline for its entire lifetime.
- Sessions created before this feature remain valid but cannot expose a trustworthy committed range.

`KimiClient.createSession` will accept optional metadata in addition to `cwd` and will merge it without allowing callers to overwrite `cwd` accidentally.

## Read-Only Git Adapter

Add a small local Git adapter, separate from Kimi HTTP concerns. It uses `execFile` or an equivalent argument-array process API, never a shell command string.

The adapter supports only read operations needed by this feature:

- Resolve `HEAD` and the current branch.
- List initial dirty paths.
- Test whether `baseCommit` is an ancestor of `HEAD`.
- List commits in `baseCommit..HEAD`.
- Read name/status and numstat data for `baseCommit..HEAD`.
- Read a patch for each file in `baseCommit..HEAD`.

Every command:

- Runs against the session metadata `cwd` using an argument, not string interpolation.
- Has a timeout and bounded output.
- Validates a stored object ID before passing it as a revision argument.
- Returns a typed unavailable result for expected Git conditions.
- Sanitizes diagnostic errors and never exposes environment variables, authorization headers, or token-like values.

The adapter must not run any mutating Git command.

## Message Selection

Kimi's messages endpoint returns its newest item first. The Bridge will centralize selection in a shared helper that:

1. Iterates in API order without reversing.
2. Considers assistant messages only.
3. Skips empty or whitespace-only content.
4. Skips known internal reminder/control messages using the same rules as recent-session summaries.
5. Redacts token-like values before returning text to Codex.

Both handoff final-message selection and recent-session assistant summaries will use this helper so their ordering and filtering cannot drift apart.

If no eligible assistant message exists, `finalMessage` remains an empty string for backward compatibility. Tests must distinguish this legitimate absence from the current ordering bug.

## Public Handoff Shape

Add structured committed and working-tree sections:

```ts
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
  unavailableReason?: string;
}

export interface KimiHandoff {
  status: string;
  finalMessage: string;

  baseCommit?: string;
  headCommit?: string;
  commits: CommitSummary[];
  initialDirtyPaths: string[];
  committedChanges: HandoffChangeSet;
  workingTreeChanges: HandoffChangeSet;

  // Compatibility aggregate across both change sets.
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}
```

### Structured Change Sets

`committedChanges` represents `baseCommit..headCommit`:

- It includes commits and files already committed by Kimi.
- It is available only when the stored baseline is valid and is an ancestor of current `HEAD`.
- An unchanged range is available with empty arrays and zero counts.

`workingTreeChanges` represents current staged, unstaged, and untracked state:

- It continues to use the existing Kimi `fs:git_status` and `fs:diff` endpoints.
- Existing untracked-directory expansion remains in place.
- It may contain changes that existed before delegation. `initialDirtyPaths` makes that ambiguity visible.

### Compatibility Aggregate

Existing consumers often read only the top-level fields, so those fields must no longer disappear after Kimi commits:

- `changedFiles` is the sorted union of both change sets.
- `additions` and `deletions` are the sums of both change sets.
- `diffs` contains one entry per source and path, with an additive optional `source` field whose value is `committed` or `working_tree`.
- If the same path has committed and uncommitted changes, it may appear twice in `diffs`, once for each source. The source field removes ambiguity while existing consumers can continue reading `path` and `diff`.

```ts
export interface FileDiff {
  path: string;
  diff: string;
  source?: 'committed' | 'working_tree';
}
```

This is additive at the type level. Existing `sessionId`, status, Web URL, and review-package fields remain unchanged.

## Review Package Behavior

`kimi_get_handoff`, `kimi_review_package`, and the embedded `reviewPackage` from `kimi_delegate_and_wait` all expose the same enriched handoff.

Review package summary data must make these cases obvious:

- Kimi committed changes and left a clean working tree.
- Kimi left only working-tree changes.
- Kimi produced both committed and additional uncommitted changes.
- No repository changes occurred.
- Committed evidence is unavailable for a legacy session.

The review package must never treat `committedChanges.available=false` as proof of no committed work. It should surface the reason and recommend direct Git inspection when necessary.

## Failure And Compatibility Behavior

Committed-range collection returns `available: false` with a stable reason in these cases:

- `baseline_unavailable`: the session has no valid baseline metadata.
- `not_a_git_repository`: the session workspace is not a Git repository.
- `head_unavailable`: the repository has no current commit.
- `base_not_ancestor`: history was rewritten or the session moved to unrelated history.
- `git_command_failed`: an unexpected bounded Git read failed.

In every case:

- Handoff message selection still works.
- Working-tree collection is still attempted.
- The Bridge does not guess a baseline or silently report an empty committed range.
- Existing sessions remain usable.

If current `HEAD` equals `baseCommit`, committed changes are available and empty. This is distinct from unavailable evidence.

## Security And Privacy

- No token is stored in session metadata or Git diagnostics.
- Git command arguments use process argument arrays and validated revisions.
- Git output limits protect MCP responses from unbounded repository history or binary patches.
- Patch truncation is explicit in the returned data or diagnostics; it must not masquerade as a complete diff.
- Existing token redaction applies to selected final messages and error text.
- `webUrl` remains token-free.

## Testing Strategy

### Message Tests

- Newest-first messages with an older empty assistant select the newest non-empty assistant report.
- Empty, whitespace-only, tool, user, and internal control messages are skipped.
- Token-like text is redacted.
- A session with no eligible assistant message returns an empty `finalMessage`.
- Recent-session summary and handoff select the same assistant message.

### Git Adapter Tests

Use temporary repositories to verify:

- Baseline capture on a clean repository.
- Initial dirty paths are recorded.
- Commit listing, file lists, numstat, and patches for `base..HEAD`.
- Clean range, no-commit repository, non-Git directory, invalid object ID, non-ancestor base, timeout, and output-limit behavior.
- Paths containing spaces and shell metacharacters are passed safely.

### Client And Tool Tests

- New session creation includes namespaced baseline metadata.
- Existing `sessionId`, dedupe reuse, and continue do not replace the original baseline.
- A committed-only task returns non-empty `commits`, `committedChanges`, aggregate `changedFiles`, and diffs while `workingTreeChanges` is empty.
- A working-tree-only task preserves current behavior.
- Mixed committed and working-tree changes remain separate and aggregate correctly, including the same path in both sources.
- Legacy sessions return an explicit unavailable committed range and still return working-tree evidence.
- Non-Git delegation succeeds and degrades predictably.
- Review package and embedded delegate-and-wait package expose identical enriched data.

### Integration And Dogfood

After installing the rebuilt plugin, create a disposable temporary Git repository with one baseline commit. Delegate a stable-titled Kimi task that changes a file and commits it. Verify through the installed MCP tools that:

- `finalMessage` contains Kimi's final report.
- `baseCommit` is the original temporary-repository commit.
- `headCommit` is Kimi's commit.
- `commits` contains Kimi's commit.
- `committedChanges.changedFiles` contains the file.
- `workingTreeChanges.changedFiles` is empty.
- Top-level `changedFiles` and `reviewPackage` still contain the file.
- Dedupe reuse returns the same baseline and review evidence.

Remove the disposable repository after the smoke test. Do not create test commits in the bridge repository.

## Documentation And Release

Update:

- `README.md` with the baseline, committed versus working-tree semantics, and legacy-session degradation.
- `AGENTS.md` so Codex reviews both structured change sets and does not infer "no changes" from a clean working tree alone.
- `docs/prompts/kimi-delegate-workflow.md` so reusable prompts require Kimi's final report and Codex's structured review.
- The plugin skill instructions so normal delegation review checks committed and working-tree evidence.

This additive feature is released as plugin version `0.3.0`. Regenerate and commit the tracked MCP bundle, validate the plugin, reinstall it, restart Codex, and run the disposable-repository dogfood flow.

## Acceptance Criteria

1. A real newest-first Kimi message list produces the latest non-empty assistant report in `finalMessage`.
2. A Kimi task that commits all work and leaves a clean working tree still produces complete structured review evidence.
3. `committedChanges` and `workingTreeChanges` are separate and their availability is explicit.
4. Top-level compatibility fields include committed work and preserve existing field names.
5. New sessions persist a validated Git baseline in namespaced Kimi metadata.
6. Existing, continued, and deduped sessions never receive a fabricated replacement baseline.
7. Pre-existing dirty paths are disclosed without claiming line-level attribution.
8. Non-Git, no-commit, legacy-session, and rewritten-history cases degrade without blocking delegation.
9. The Bridge executes no mutating Git command and does not leak credentials.
10. `pnpm test`, `pnpm typecheck`, `pnpm build`, and plugin validation pass.
11. The installed-plugin dogfood test proves committed-only handoff, non-empty final message, and dedupe reuse in a disposable repository.

