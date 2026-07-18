import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitSummary, FileDiff, HandoffChangeSet } from './handoff.js';

const execFileAsync = promisify(execFile);

const OBJECT_ID_RE = /^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/;

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

type UnavailableReason =
  | 'baseline_unavailable'
  | 'not_a_git_repository'
  | 'head_unavailable'
  | 'base_not_ancestor'
  | 'git_command_failed';

type ExecError = { code?: number | string; stderr?: string | Buffer; message?: string };

function isExecError(error: unknown): error is ExecError {
  return typeof error === 'object' && error !== null && ('code' in error || 'stderr' in error || 'message' in error);
}

function sanitizeError(error: unknown): string {
  if (!isExecError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const stderr = typeof error.stderr === 'string' ? error.stderr : error.stderr?.toString('utf8') ?? '';
  const message = error.message ?? '';
  const combined = `${message} ${stderr}`.trim();
  // Strip common Git path prefixes and newlines to keep diagnostics concise and token-free.
  return combined
    .replace(/fatal:\s*/g, '')
    .replace(/error:\s*/g, '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

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
  ): Promise<{ ok: true; stdout: Buffer } | { ok: false; code?: number | string; error: string }> {
    try {
      const stdout = await this.git(cwd, args, maxBuffer);
      return { ok: true, stdout };
    } catch (err) {
      const execErr = isExecError(err) ? err : {};
      return { ok: false, code: execErr.code, error: sanitizeError(err) };
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

    return {
      available: true,
      baseline: {
        schemaVersion: 1,
        baseCommit,
        baseBranch,
        initialDirtyPaths: initialDirtyPaths.sort(),
      },
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

    const repoCheck = await this.tryGit(cwd, ['rev-parse', '--git-dir'], this.metadataMaxBuffer);
    if (!repoCheck.ok) {
      return {
        baseCommit: baseline.baseCommit,
        headCommit: undefined,
        commits: [],
        changeSet: this.unavailableChangeSet('not_a_git_repository'),
      };
    }

    const headResult = await this.tryGit(cwd, ['rev-parse', 'HEAD'], this.metadataMaxBuffer);
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
      cwd,
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
      const commits = await this.listCommits(cwd, baseline.baseCommit, headCommit);
      const { changedFiles, additions, deletions } = await this.collectStats(cwd, baseline.baseCommit, headCommit);
      const { diffs, truncatedPaths } = await this.collectPatches(cwd, baseline.baseCommit, headCommit);

      return {
        baseCommit: baseline.baseCommit,
        headCommit,
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
    const stdout = await this.git(cwd, ['diff', `${base}..${head}`, '--numstat'], this.metadataMaxBuffer);
    const lines = stdout.toString('utf8').trim().split('\n').filter(Boolean);
    let additions = 0;
    let deletions = 0;
    const changedFiles: string[] = [];
    for (const line of lines) {
      const numMatch = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      const binaryMatch = line.match(/^-\t-\t(.+)$/);
      if (!numMatch && !binaryMatch) continue;
      const pathPart = numMatch ? numMatch[3] : binaryMatch![1];
      if (numMatch) {
        additions += parseInt(numMatch[1], 10);
        deletions += parseInt(numMatch[2], 10);
      }
      const arrowIndex = pathPart.indexOf(' => ');
      changedFiles.push(arrowIndex >= 0 ? pathPart.slice(arrowIndex + 4) : pathPart);
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
      } catch (err) {
        const execErr = isExecError(err) ? err : {};
        if (execErr.code === 'ENOBUFS' || execErr.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          truncatedPaths.push(path);
        } else {
          throw err;
        }
      }
    }
    return { diffs, truncatedPaths };
  }
}
