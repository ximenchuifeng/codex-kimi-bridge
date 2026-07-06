import type { KimiHttpClient } from './http.js';
import type { PermissionMode, PromptSubmitResult, SessionStatus, WireSession } from './types.js';

export interface HttpPort {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CreateSessionInput {
  cwd: string;
  title?: string;
}

export interface SubmitPromptInput {
  content: string;
  model: string;
  thinking: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode?: boolean;
}

export class KimiClient {
  constructor(private readonly http: KimiHttpClient | HttpPort) {}

  createSession(input: CreateSessionInput): Promise<WireSession> {
    return this.http.post('/sessions', {
      ...(input.title ? { title: input.title } : {}),
      metadata: { cwd: input.cwd },
    });
  }

  getStatus(sessionId: string): Promise<SessionStatus> {
    return this.http.get(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  submitPrompt(sessionId: string, input: SubmitPromptInput): Promise<PromptSubmitResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      content: [{ type: 'text', text: input.content }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_mode: input.planMode,
      ...(input.swarmMode === undefined ? {} : { swarm_mode: input.swarmMode }),
    });
  }
}
