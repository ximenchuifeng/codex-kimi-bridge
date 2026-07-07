export interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

export type PermissionMode = 'manual' | 'auto' | 'yolo';

export interface WireSession {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  metadata: { cwd: string; [key: string]: unknown };
  agent_config: Record<string, unknown>;
  last_seq: number;
}

export interface PromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
}

export interface SessionStatus {
  status: WireSession['status'];
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

export interface KimiServerConfig {
  default_model?: string;
}

export interface PendingApproval {
  approval_id: string;
  [key: string]: unknown;
}

export interface PendingQuestion {
  question_id: string;
  [key: string]: unknown;
}

export interface ListSessionsInput {
  pageSize?: number;
  status?: string;
  includeArchive?: boolean;
  excludeEmpty?: boolean;
}

export interface RecentSessionSummary {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  messageCount?: number;
  messagesUnavailable?: boolean;
  messageError?: string;
}

export interface RecentSession {
  sessionId: string;
  status: WireSession['status'];
  title: string;
  webUrl: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: RecentSessionSummary;
}

export interface ListSessionsResult {
  items: Array<WireSession & { created_at?: string; updated_at?: string }>;
}
