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
}

export interface KimiHandoff {
  status: string;
  finalMessage: string;
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffs: FileDiff[];
}

export function buildHandoff(input: BuildHandoffInput): KimiHandoff {
  const finalAssistant = [...input.messages].reverse().find((message) => message.role === 'assistant');
  return {
    status: input.waitStatus,
    finalMessage: finalAssistant?.content ?? '',
    changedFiles: Object.keys(input.gitStatus.entries).sort(),
    additions: input.gitStatus.additions,
    deletions: input.gitStatus.deletions,
    diffs: [...input.diffs],
  };
}
