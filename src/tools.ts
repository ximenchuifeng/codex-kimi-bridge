import type { BridgeConfig } from './config.js';
import { buildContinuationPrompt, buildDelegationPrompt } from './prompt.js';
import type { KimiHandoff } from './handoff.js';
import type { KimiClient } from './kimi/client.js';
import { waitUntilIdle, type WaitUntilIdleResult } from './kimi/wait.js';
import { buildHandoff } from './handoff.js';
import type { BridgeStatus, KimiPreflight } from './preflight.js';

export interface ToolDeps {
  kimi: KimiClient;
  config: BridgeConfig;
  preflight: KimiPreflight;
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
  kimi_wait_until_idle: (input: WaitUntilIdleInput) => Promise<WaitUntilIdleResult>;
  kimi_get_handoff: (input: GetHandoffInput) => Promise<KimiHandoff>;
  kimi_continue_task: (input: ContinueTaskInput) => Promise<{ sessionId: string; promptId: string; status: string }>;
  kimi_get_diff: (input: GetDiffInput) => Promise<{ path: string; diff: string }>;
  kimi_abort: (input: AbortInput) => Promise<{ sessionId: string; aborted: true }>;
  kimi_bridge_status: () => Promise<BridgeStatus>;
}

function withPreflight<T extends unknown[], R>(
  preflight: KimiPreflight,
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return async (...args: T) => {
    await preflight.ensureReady();
    return fn(...args);
  };
}

async function resolveModel(
  kimi: KimiClient,
  inputModel: string | undefined,
  config: BridgeConfig,
): Promise<string> {
  const model = inputModel ?? config.defaultModel ?? await kimi.resolveDefaultModel();
  if (!model) {
    throw new Error('No model specified. Pass model in the MCP call, set KIMI_MODEL, or configure default_model in Kimi server.');
  }
  return model;
}

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  const handlers: ToolHandlers = {
    async kimi_bridge_status() {
      return deps.preflight.getStatus();
    },

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
        model: await resolveModel(deps.kimi, input.model, deps.config),
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
      if (result.status === 'awaiting_approval') {
        return {
          status: result.status,
          approvals: await deps.kimi.listPendingApprovals(input.sessionId),
        };
      }
      if (result.status === 'awaiting_question') {
        return {
          status: result.status,
          questions: await deps.kimi.listPendingQuestions(input.sessionId),
        };
      }
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
        model: await resolveModel(deps.kimi, input.model, deps.config),
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

  return {
    ...handlers,
    kimi_delegate_task: withPreflight(deps.preflight, handlers.kimi_delegate_task),
    kimi_wait_until_idle: withPreflight(deps.preflight, handlers.kimi_wait_until_idle),
    kimi_get_handoff: withPreflight(deps.preflight, handlers.kimi_get_handoff),
    kimi_continue_task: withPreflight(deps.preflight, handlers.kimi_continue_task),
    kimi_get_diff: withPreflight(deps.preflight, handlers.kimi_get_diff),
    kimi_abort: withPreflight(deps.preflight, handlers.kimi_abort),
  };
}
