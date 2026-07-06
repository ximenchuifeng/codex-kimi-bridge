import type { BridgeConfig } from './config.js';
import { buildDelegationPrompt } from './prompt.js';
import type { KimiClient } from './kimi/client.js';

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

export function createToolHandlers(deps: ToolDeps) {
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
        model: input.model ?? deps.config.defaultModel ?? 'default',
        thinking: input.thinking ?? deps.config.defaultThinking,
        permissionMode: deps.config.defaultPermissionMode,
        planMode: false,
        swarmMode: input.swarmMode,
      });
      return { sessionId: session.id, promptId: result.prompt_id, status: result.status };
    },
  };
}
