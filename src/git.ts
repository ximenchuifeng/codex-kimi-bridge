import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { CommitSummary, FileDiff, HandoffChangeSet } from './handoff.js';

const execFileAsync = promisify(execFile);

export const OBJECT_ID_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

export interface WorktreeSnapshot {
  path: string;
  headCommit: string;
}

export interface GitBaseline {
  schemaVersion: 1;
  baseCommit: string;
  baseBranch?: string;
  initialDirtyPaths: string[];
  worktrees?: WorktreeSnapshot[];
}

export type BaselineCaptureResult =
  | { available: true; baseline: GitBaseline }
  | { available: false; unavailableReason: 'not_a_git_repository' | 'head_unavailable' | 'git_command_failed' };

export interface CommittedChangeResult {
  baseCommit?: string;
  headCommit?: string;
  reviewWorkspace?: string;
  commits: CommitSummary[];
  changeSet: HandoffChangeSet;
  diagnostics?: {
    candidates?: Array<{ path: string; headCommit: string; baselineHeadCommit?: string | null }>;
  };
}

export interface GitInspector {
  captureBaseline(cwd: string): Promise<BaselineCaptureResult>;
  collectCommittedChanges(cwd: string, baseline?: GitBaseline): Promise<CommittedChangeResult>;
}

type UnavailableReason =
  | 'baseline_unavailable'
  | 'not_a_git_repository'
  | 'head_unavailable'
  | 'base_not_ancestor'
  | 'git_command_failed'
  | 'ambiguous_worktrees';

function isBufferOutput(output: unknown): output is Buffer {
  return Buffer.isBuffer(output);
}

function parseNulStatus(buffer: Buffer): Array<{ path: string; status: string }> {
  const text = buffer.toString('utf8');
  const parts = text.split('\0').filter(Boolean);
  const entries: Array<{ path: string; status: string }> = [];
  let i = 0;
  while (i < parts.length) {
    const entry = parts[i];
    if (entry.length < 3 || entry[2] !== ' ') {
      i += 1;
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') {
      // `git status --porcelain=v1 -z` lists the new path first, then the
      // original path. Keep the new path and skip the original.
      entries.push({ status, path });
      i += 2;
      continue;
    }
    entries.push({ status, path });
    i += 1;
  }
  return entries;
}

function parseWorktreeList(buffer: Buffer): WorktreeSnapshot[] {
  const text = buffer.toString('utf8');
  // Records are separated by double NUL bytes; each line inside a record is
  // NUL-terminated. The final record also ends with a double NUL.
  const records = text.split('\0\0').filter((record) => record.length > 0);
  const worktrees: WorktreeSnapshot[] = [];
  for (const record of records) {
    let worktreePath: string | undefined;
    let headCommit: string | undefined;
    for (const line of record.split('\0')) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        headCommit = line.slice('HEAD '.length);
      }
    }
    if (worktreePath && headCommit && OBJECT_ID_RE.test(headCommit)) {
      worktrees.push({ path: worktreePath, headCommit });
    }
  }
  return worktrees;
}

export class NodeGitInspector implements GitInspector {
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options?: { timeoutMs?: number; maxOutputBytes?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.maxOutputBytes = options?.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  private get metadataMaxBuffer(): number {
    // Keep commit lists, name/status, and stat data readable even when the
    // caller configures a very small patch limit.
    return Math.max(this.maxOutputBytes, 1_048_576);
  }

  private normalizeWorktreePath(p: string): string {
    const normalized = path.normalize(p);
    return normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
  }

  private async git(cwd: string, args: string[], maxBuffer?: number): Promise<Buffer> {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: this.timeoutMs,
      maxBuffer: maxBuffer ?? this.maxOutputBytes,
      encoding: 'buffer',
    });
    if (!isBufferOutput(result.stdout)) {
      throw new Error('Unexpected non-buffer output from git command');
    }
    return result.stdout;
  }

  private async tryGit(
    cwd: string,
    args: string[],
    maxBuffer?: number,
  ): Promise<{ ok: true; stdout: Buffer } | { ok: false; code?: number | string }> {
    try {
      const stdout = await this.git(cwd, args, maxBuffer);
      return { ok: true, stdout };
    } catch (err) {
      const execErr = err as { code?: number | string } | undefined;
      return { ok: false, code: execErr?.code };
    }
  }

  async captureBaseline(cwd: string): Promise<BaselineCaptureResult> {
    const repoCheck = await this.tryGit(cwd, ['rev-parse', '--git-dir'], this.metadataMaxBuffer);
    if (!repoCheck.ok) {
      return { available: false, unavailableReason: 'not_a_git_repository' };
    }

    const headResult = await this.tryGit(cwd, ['rev-parse', 'HEAD'], this.metadataMaxBuffer);
    if (!headResult.ok) {
      return { available: false, unavailableReason: 'head_unavailable' };
    }

    const baseCommit = headResult.stdout.toString('utf8').trim();
    if (!OBJECT_ID_RE.test(baseCommit)) {
      return { available: false, unavailableReason: 'git_command_failed' };
    }

    const branchResult = await this.tryGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], this.metadataMaxBuffer);
    const baseBranch = branchResult.ok ? branchResult.stdout.toString('utf8').trim() : undefined;

    const initialDirtyPaths: string[] = [];
    const statusResult = await this.tryGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], this.metadataMaxBuffer);
    if (statusResult.ok) {
      for (const entry of parseNulStatus(statusResult.stdout)) {
        initialDirtyPaths.push(entry.path);
      }
    }

    let worktrees: WorktreeSnapshot[] | undefined;
    const worktreeResult = await this.tryGit(cwd, ['worktree', 'list', '--porcelain', '-z'], this.metadataMaxBuffer);
    if (worktreeResult.ok) {
      worktrees = parseWorktreeList(worktreeResult.stdout);
    }

    return {
      available: true,
      baseline: {
        schemaVersion: 1,
        baseCommit,
        baseBranch,
        initialDirtyPaths: initialDirtyPaths.sort(),
        worktrees,
      },
    };
  }

  private async resolveReviewWorkspace(
    sessionCwd: string,
    baseline: GitBaseline,
  ): Promise<
    | { kind: 'selected'; path: string }
    | { kind: 'fallback'; path: string }
    | {
        kind: 'unavailable';
        reason: UnavailableReason;
        diagnostics?: { candidates: Array<{ path: string; headCommit: string; baselineHeadCommit?: string | null }> };
      }
  > {
    if (!baseline.worktrees || baseline.worktrees.length === 0) {
      return { kind: 'fallback', path: sessionCwd };
    }

    const listResult = await this.tryGit(sessionCwd, ['worktree', 'list', '--porcelain', '-z'], this.metadataMaxBuffer);
    if (!listResult.ok) {
      return { kind: 'fallback', path: sessionCwd };
    }

    const currentWorktrees = parseWorktreeList(listResult.stdout);
    const baselineByPath = new Map(
      baseline.worktrees.map((wt) => [this.normalizeWorktreePath(wt.path), wt]),
    );
    const candidates: Array<{ path: string; headCommit: string; baselineHeadCommit?: string | null }> = [];

    for (const current of currentWorktrees) {
      const normalizedPath = this.normalizeWorktreePath(current.path);
      const baselineEntry = baselineByPath.get(normalizedPath);
      if (baselineEntry) {
        // Only worktrees that were at the baseline commit when delegation
        // started and have since advanced are valid review workspaces.
        if (baselineEntry.headCommit === baseline.baseCommit && current.headCommit !== baseline.baseCommit) {
          candidates.push({ path: current.path, headCommit: current.headCommit, baselineHeadCommit: baselineEntry.headCommit });
        }
      } else {
        // Worktrees created after delegation began are valid candidates when
        // they have moved past the baseline commit.
        if (current.headCommit !== baseline.baseCommit) {
          candidates.push({ path: current.path, headCommit: current.headCommit, baselineHeadCommit: null });
        }
      }
    }

    if (candidates.length === 1) {
      return { kind: 'selected', path: candidates[0].path };
    }
    if (candidates.length === 0) {
      return { kind: 'fallback', path: sessionCwd };
    }
    return {
      kind: 'unavailable',
      reason: 'ambiguous_worktrees',
      diagnostics: { candidates },
    };
  }

  async collectCommittedChanges(cwd: string, baseline?: GitBaseline): Promise<CommittedChangeResult> {
    if (!baseline || baseline.schemaVersion !== 1) {
      return {
        baseCommit: undefined,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('baseline_unavailable'),
      };
    }

    if (!OBJECT_ID_RE.test(baseline.baseCommit)) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('git_command_failed'),
      };
    }

    const resolution = await this.resolveReviewWorkspace(cwd, baseline);
    if (resolution.kind === 'unavailable') {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet(resolution.reason),
        diagnostics: resolution.diagnostics,
      };
    }

    const inspectCwd = resolution.path;
    const repoCheck = await this.tryGit(inspectCwd, ['rev-parse', '--git-dir'], this.metadataMaxBuffer);
    if (!repoCheck.ok) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('not_a_git_repository'),
      };
    }

    const headResult = await this.tryGit(inspectCwd, ['rev-parse', 'HEAD'], this.metadataMaxBuffer);
    if (!headResult.ok) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('head_unavailable'),
      };
    }

    const headCommit = headResult.stdout.toString('utf8').trim();
    if (!OBJECT_ID_RE.test(headCommit)) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('git_command_failed'),
      };
    }

    const ancestorResult = await this.tryGit(
      inspectCwd,
      ['merge-base', '--is-ancestor', baseline.baseCommit, 'HEAD'],
      this.metadataMaxBuffer,
    );
    if (!ancestorResult.ok) {
      if (ancestorResult.code === 1) {
        return {
          baseCommit: baseline.baseCommit,
          headCommit,
          commits: [],
          changeSet: this.unavailableChangeSet('base_not_ancestor'),
        };
      }
      return {
        baseCommit: baseline.baseCommit,
        headCommit,
        commits: [],
        changeSet: this.unavailableChangeSet('git_command_failed'),
      };
    }

    try {
      const commits = await this.listCommits(inspectCwd, baseline.baseCommit, headCommit);
      const { changedFiles, additions, deletions } = await this.collectStats(inspectCwd, baseline.baseCommit, headCommit);
      const { diffs, truncatedPaths } = await this.collectPatches(inspectCwd, baseline.baseCommit, headCommit);

      return {
        baseCommit: baseline.baseCommit,
        headCommit,
        reviewWorkspace: resolution.kind === 'selected' ? inspectCwd : undefined,
        commits,
        changeSet: {
          available: true,
          changedFiles,
          additions,
          deletions,
          diffs,
          truncatedPaths,
        },
      };
    } catch (err) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit,
        commits: [],
        changeSet: this.unavailableChangeSet('git_command_failed'),
      };
    }
  }

  private unavailableChangeSet(reason: UnavailableReason): HandoffChangeSet {
    return {
      available: false,
      changedFiles: [],
      additions: 0,
      deletions: 0,
      diffs: [],
      truncatedPaths: [],
      unavailableReason: reason,
    };
  }

  private async listCommits(cwd: string, base: string, head: string): Promise<CommitSummary[]> {
    const stdout = await this.git(
      cwd,
      ['log', `${base}..${head}`, '--format=%H%x00%s', '--no-merges', '-z'],
      this.metadataMaxBuffer,
    );
    const raw = stdout.toString('utf8');
    const items = raw.split('\0').filter(Boolean);
    const commits: CommitSummary[] = [];
    for (let i = 0; i < items.length; i += 2) {
      const sha = items[i];
      const subject = items[i + 1] ?? '';
      commits.push({ sha, shortSha: sha.slice(0, 7), subject });
    }
    return commits;
  }

  private async collectStats(
    cwd: string,
    base: string,
    head: string,
  ): Promise<{ changedFiles: string[]; additions: number; deletions: number }> {
    const stdout = await this.git(cwd, ['diff', `${base}..${head}`, '--numstat', '-z'], this.metadataMaxBuffer);
    const parts = stdout.toString('utf8').split('\0');
    let additions = 0;
    let deletions = 0;
    const changedFiles: string[] = [];
    let i = 0;
    while (i < parts.length - 1) {
      const segment = parts[i];
      const fields = segment.split('\t');
      if (fields.length !== 3) {
        i += 1;
        continue;
      }
      const [addField, delField, path] = fields;
      if (path) {
        // Normal or binary single-path record.
        if (addField === '-' && delField === '-') {
          // Binary file: no line counts.
        } else {
          additions += parseInt(addField, 10);
          deletions += parseInt(delField, 10);
        }
        changedFiles.push(path);
        i += 1;
        continue;
      }
      // Rename/copy: the path field is empty, followed by the original path
      // and then the new path.
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (newPath) {
        if (addField === '-' && delField === '-') {
          // Binary rename/copy.
        } else {
          additions += parseInt(addField, 10);
          deletions += parseInt(delField, 10);
        }
        changedFiles.push(newPath);
      }
      i += 3;
    }
    return { changedFiles: changedFiles.sort(), additions, deletions };
  }

  private async collectPatches(
    cwd: string,
    base: string,
    head: string,
  ): Promise<{ diffs: FileDiff[]; truncatedPaths: string[] }> {
    const nameResult = await this.git(cwd, ['diff', `${base}..${head}`, '--name-only', '-z'], this.metadataMaxBuffer);
    const paths = nameResult.toString('utf8').split('\0').filter(Boolean);
    const diffs: FileDiff[] = [];
    const truncatedPaths: string[] = [];
    for (const path of paths) {
      try {
        const patch = await this.git(cwd, ['diff', `${base}..${head}`, '--', path]);
        diffs.push({ path, diff: patch.toString('utf8'), source: 'committed' });
      } catch {
        // Treat any per-file diff failure as truncated so that commit/file/stat
        // evidence is preserved even when a single patch cannot be retrieved.
        truncatedPaths.push(path);
      }
    }
    return { diffs, truncatedPaths };
  }
}
