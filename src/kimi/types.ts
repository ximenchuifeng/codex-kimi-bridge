export interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

export type PermissionMode = 'manual' | 'auto' | 'yolo';

import type { BridgeRuntimeStatus } from './runtime-status.js';
export type { BridgeRuntimeStatus };

export interface WireSession {
  id: string;
  title: string;
  status?: unknown;
  busy?: unknown;
  pending_interaction?: unknown;
  last_turn_reason?: unknown;
  metadata: { cwd: string; [key: string]: unknown };
  agent_config: Record<string, unknown>;
  last_seq: number;
}

export type RuntimeSession = Omit<WireSession, 'status'> & {
  status: BridgeRuntimeStatus;
};

export interface PromptSubmitResult {
  prompt_id: string;
  user_message_id: string;
  status: 'running' | 'queued';
}

export interface SessionStatus {
  status?: unknown;
  busy?: unknown;
  model?: string;
  thinking_level: string;
  permission: string;
  plan_mode: boolean;
  swarm_mode: boolean;
  context_tokens: number;
  max_context_tokens: number;
  context_usage: number;
}

export interface KimiServerMeta {
  server_version?: string;
  backend?: string;
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

export interface CodexKimiBridgeMetadata {
  schema_version: 1;
  base_commit: string;
  base_branch?: string;
  initial_dirty_paths: string[];
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
  status: BridgeRuntimeStatus;
  title: string;
  webUrl: string;
  cwd?: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: RecentSessionSummary;
}

export interface ListSessionsResult {
  items: Array<RuntimeSession & { created_at?: string; updated_at?: string }>;
}
