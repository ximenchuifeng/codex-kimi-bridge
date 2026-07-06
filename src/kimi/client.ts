import type { KimiHttpClient } from './http.js';
import type { KimiServerConfig, PermissionMode, PromptSubmitResult, SessionStatus, WireSession } from './types.js';

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

export interface WireMessage {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
}

export interface GitStatusResult {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

function messageText(message: WireMessage): string {
  return message.content.map((part) => part.text ?? '').join('');
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

  async listMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    const page = await this.http.get<{ items: WireMessage[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
    return page.items.map((message) => ({ role: message.role, content: messageText(message) }));
  }

  getGitStatus(sessionId: string): Promise<GitStatusResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:git_status`, {});
  }

  getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string }> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:diff`, { path });
  }

  abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}:abort`);
  }

  getConfig(): Promise<KimiServerConfig> {
    return this.http.get('/config');
  }

  async resolveDefaultModel(): Promise<string | undefined> {
    const config = await this.getConfig();
    const model = config.default_model;
    return model && model.trim().length > 0 ? model : undefined;
  }
}
