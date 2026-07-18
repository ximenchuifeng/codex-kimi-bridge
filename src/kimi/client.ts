import type { KimiHttpClient } from './http.js';
import { normalizeRuntimeStatus, type BridgeRuntimeStatus } from './runtime-status.js';
import type { KimiServerConfig, KimiServerMeta, ListSessionsInput, ListSessionsResult, PendingApproval, PendingQuestion, PermissionMode, PromptSubmitResult, RuntimeSession, SessionStatus, WireSession } from './types.js';

export interface HttpPort {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CreateSessionInput {
  cwd: string;
  title?: string;
  metadata?: Record<string, unknown>;
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

const MAX_SESSION_LIST_PAGE_SIZE = 100;

function normalizeSession(session: WireSession): RuntimeSession {
  const { status: _wireStatus, ...rest } = session;
  return {
    ...rest,
    status: normalizeRuntimeStatus(session),
  };
}

export class KimiClient {
  constructor(private readonly http: KimiHttpClient | HttpPort) {}

  async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
    const session = await this.http.post<WireSession>('/sessions', {
      ...(input.title ? { title: input.title } : {}),
      metadata: {
        ...input.metadata,
        cwd: input.cwd,
      },
    });
    return normalizeSession(session);
  }

  getStatus(sessionId: string): Promise<SessionStatus> {
    return this.http.get(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  async getSession(sessionId: string): Promise<RuntimeSession> {
    const session = await this.http.get<WireSession>(`/sessions/${encodeURIComponent(sessionId)}`);
    return normalizeSession(session);
  }

  async getRuntimeStatus(sessionId: string): Promise<BridgeRuntimeStatus> {
    return (await this.getSession(sessionId)).status;
  }

  getMeta(): Promise<KimiServerMeta> {
    return this.http.get('/meta');
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

  async listPendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    const page = await this.http.get<{ items: PendingApproval[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/approvals`,
      { status: 'pending' },
    );
    return page.items;
  }

  async listPendingQuestions(sessionId: string): Promise<PendingQuestion[]> {
    const page = await this.http.get<{ items: PendingQuestion[] }>(
      `/sessions/${encodeURIComponent(sessionId)}/questions`,
      { status: 'pending' },
    );
    return page.items;
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const requestedPageSize = input.pageSize ?? 20;
    const page = await this.http.get<{ items: WireSession[] }>('/sessions', {
      page_size: input.status === undefined ? requestedPageSize : MAX_SESSION_LIST_PAGE_SIZE,
      include_archive: input.includeArchive,
      exclude_empty: input.excludeEmpty,
    });
    const normalized = page.items.map(normalizeSession);
    const filtered = input.status === undefined
      ? normalized
      : normalized.filter((session) => session.status === input.status);
    return { items: filtered.slice(0, requestedPageSize) };
  }
}
