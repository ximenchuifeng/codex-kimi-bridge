export interface HandoffMessage {
  role: string;
  content: string;
}

export interface GitStatusSummary {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  diff: string;
}

export interface BuildHandoffInput {
  messages: readonly HandoffMessage[];
  gitStatus: GitStatusSummary;
  diffs: readonly FileDiff[];
  waitStatus: string;
  changedFiles?: string[];
}

export interface KimiHandoff {
  status: string;
  finalMessage: string;
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

export function buildHandoff(input: BuildHandoffInput): KimiHandoff {
  const finalAssistant = [...input.messages].reverse().find((message) => message.role === 'assistant');
  return {
    status: input.waitStatus,
    finalMessage: finalAssistant?.content ?? '',
    changedFiles: input.changedFiles ?? Object.keys(input.gitStatus.entries).sort(),
    additions: input.gitStatus.additions,
    deletions: input.gitStatus.deletions,
    diffs: [...input.diffs],
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
