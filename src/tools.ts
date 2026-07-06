import type { BridgeConfig } from './config.js';
import { buildContinuationPrompt, buildDelegationPrompt } from './prompt.js';
import type { KimiHandoff } from './handoff.js';
import type { KimiClient } from './kimi/client.js';
import { waitUntilIdle } from './kimi/wait.js';
import { buildHandoff } from './handoff.js';

export interface ToolDeps {
  kimi: KimiClient;
  config: BridgeConfig;
}

export interface DelegateTaskInput {
  cwd: string;
  task: string;
  acceptanceCriteria: string[];
  plan: string[];
  swarmMode?: boolean;
  sessionId?: string;
  model?: string;
  thinking?: string;
}

export interface WaitUntilIdleInput {
  sessionId: string;
  timeoutMs?: number;
}

export interface GetHandoffInput {
  sessionId: string;
}

export interface ContinueTaskInput {
  sessionId: string;
  task: string;
  acceptanceCriteria?: string[];
  plan?: string[];
  swarmMode?: boolean;
  model?: string;
  thinking?: string;
}

export interface GetDiffInput {
  sessionId: string;
  path: string;
}

export interface AbortInput {
  sessionId: string;
}

export interface ToolHandlers {
  kimi_delegate_task: (input: DelegateTaskInput) => Promise<{ sessionId: string; promptId: string; status: string }>;
  kimi_wait_until_idle: (input: WaitUntilIdleInput) => Promise<{ status: string }>;
  kimi_get_handoff: (input: GetHandoffInput) => Promise<KimiHandoff>;
  kimi_continue_task: (input: ContinueTaskInput) => Promise<{ sessionId: string; promptId: string; status: string }>;
  kimi_get_diff: (input: GetDiffInput) => Promise<{ path: string; diff: string }>;
  kimi_abort: (input: AbortInput) => Promise<{ sessionId: string; aborted: true }>;
}

function resolveModel(inputModel: string | undefined, config: BridgeConfig): string {
  const model = inputModel ?? config.defaultModel;
  if (!model) {
    throw new Error('No model specified and no default model configured (set KIMI_MODEL or config.defaultModel)');
  }
  return model;
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  return {
    async kimi_delegate_task(input: DelegateTaskInput) {
      const session = input.sessionId
        ? { id: input.sessionId }
        : await deps.kimi.createSession({ cwd: input.cwd, title: input.task.slice(0, 80) });
      const prompt = buildDelegationPrompt({
        task: input.task,
        acceptanceCriteria: input.acceptanceCriteria,
        plan: input.plan,
        swarmSuggestions: input.swarmMode ? input.plan : undefined,
      });
      const result = await deps.kimi.submitPrompt(session.id, {
        content: prompt,
        model: resolveModel(input.model, deps.config),
        thinking: input.thinking ?? deps.config.defaultThinking,
        permissionMode: deps.config.defaultPermissionMode,
        planMode: false,
        swarmMode: input.swarmMode,
      });
      return { sessionId: session.id, promptId: result.prompt_id, status: result.status };
    },

    async kimi_wait_until_idle(input: WaitUntilIdleInput) {
      const result = await waitUntilIdle({
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs ?? deps.config.requestTimeoutMs,
        pollStatus: () => deps.kimi.getStatus(input.sessionId),
      });
      return result;
    },

    async kimi_get_handoff(input: GetHandoffInput) {
      const [status, messages, gitStatus] = await Promise.all([
        deps.kimi.getStatus(input.sessionId),
        deps.kimi.listMessages(input.sessionId),
        deps.kimi.getGitStatus(input.sessionId),
      ]);

      const changedFiles = Object.keys(gitStatus.entries);
      const diffs = await Promise.all(changedFiles.map((path) => deps.kimi.getFileDiff(input.sessionId, path)));

      return buildHandoff({ messages, gitStatus, diffs, waitStatus: status.status });
    },

    async kimi_continue_task(input: ContinueTaskInput) {
      const prompt = buildContinuationPrompt({
        sessionId: input.sessionId,
        task: input.task,
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        plan: input.plan ?? [],
        swarmSuggestions: input.swarmMode ? input.plan : undefined,
      });
      const result = await deps.kimi.submitPrompt(input.sessionId, {
        content: prompt,
        model: resolveModel(input.model, deps.config),
        thinking: input.thinking ?? deps.config.defaultThinking,
        permissionMode: deps.config.defaultPermissionMode,
        planMode: false,
        swarmMode: input.swarmMode,
      });
      return { sessionId: input.sessionId, promptId: result.prompt_id, status: result.status };
    },

    async kimi_get_diff(input: GetDiffInput) {
      return deps.kimi.getFileDiff(input.sessionId, input.path);
    },

    async kimi_abort(input: AbortInput) {
      await deps.kimi.abortSession(input.sessionId);
      return { sessionId: input.sessionId, aborted: true };
    },
  };
}
