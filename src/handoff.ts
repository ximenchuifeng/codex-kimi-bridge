import { selectLatestMeaningfulMessage } from './messages.js';

export interface HandoffMessage {
  role: string;
  content: string;
}

export interface GitStatusSummary {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

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

export interface KimiHandoff {
  status: string;
  finalMessage: string;
  baseCommit?: string;
  headCommit?: string;
  commits: CommitSummary[];
  initialDirtyPaths: string[];
  committedChanges: HandoffChangeSet;
  workingTreeChanges: HandoffChangeSet;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}

export interface ExpandGitStatusEntriesInput {
  entries: Record<string, string>;
  baseDir: string;
  listFiles: (baseDir: string, relativeDir: string) => Promise<string[]>;
  isUntrackedDir?: (path: string, status: string) => boolean;
}

function sortedUniqueUnion(a: readonly string[], b: readonly string[]): string[] {
  return Array.from(new Set([...a, ...b])).sort();
}

export function buildHandoff(input: BuildHandoffInput): KimiHandoff {
  const finalMessage = selectLatestMeaningfulMessage(
    input.messages,
    'assistant',
    input.serverToken,
  ) ?? '';
  const committed = input.committedChanges;
  const working = input.workingTreeChanges;
  const changedFiles = sortedUniqueUnion(committed.changedFiles, working.changedFiles);
  const diffs = [
    ...committed.diffs.slice().sort((a, b) => a.path.localeCompare(b.path)),
    ...working.diffs.slice().sort((a, b) => a.path.localeCompare(b.path)),
  ];
  return {
    status: input.waitStatus,
    finalMessage,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
    commits: [...input.commits],
    initialDirtyPaths: [...input.initialDirtyPaths],
    committedChanges: committed,
    workingTreeChanges: working,
    changedFiles,
    additions: committed.additions + working.additions,
    deletions: committed.deletions + working.deletions,
    diffs,
  };
}

export async function expandGitStatusEntries(input: ExpandGitStatusEntriesInput): Promise<string[]> {
  const isUntrackedDir = input.isUntrackedDir ?? ((path, status) => path.endsWith('/') && status === '??');
  const expanded = new Set<string>();

  for (const [path, status] of Object.entries(input.entries)) {
    if (isUntrackedDir(path, status)) {
      try {
        const files = await input.listFiles(input.baseDir, path);
        if (files.length === 0) {
          expanded.add(path);
        } else {
          for (const file of files) {
            expanded.add(file);
          }
        }
      } catch {
        expanded.add(path);
      }
    } else {
      expanded.add(path);
    }
  }

  return Array.from(expanded).sort();
}
