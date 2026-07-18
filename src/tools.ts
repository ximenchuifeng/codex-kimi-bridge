import type { BridgeConfig } from './config.js';
import { buildContinuationPrompt, buildDelegationPrompt } from './prompt.js';
import type { KimiHandoff } from './handoff.js';
import type { KimiClient } from './kimi/client.js';
import { waitUntilIdle, type WaitUntilIdleResult } from './kimi/wait.js';
import { buildHandoff, expandGitStatusEntries, type HandoffChangeSet } from './handoff.js';
import { sanitizeDiagnosticText, selectLatestMeaningfulMessage } from './messages.js';
import type { BridgeRuntimeStatus, ListSessionsInput, RecentSession, RecentSessionSummary, RuntimeSession, WireSession } from './kimi/types.js';
import type { BridgeStatus, KimiPreflight } from './preflight.js';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { NodeGitInspector, type GitInspector, type GitBaseline, OBJECT_ID_RE } from './git.js';

export interface FileLister {
  listFiles(baseDir: string, relativeDir: string): Promise<string[]>;
}

export interface ToolDeps {
  kimi: KimiClient;
  config: BridgeConfig;
  preflight: KimiPreflight;
  fileLister?: FileLister;
  gitInspector?: GitInspector;
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

export interface DelegateAndWaitInput extends DelegateTaskInput {
  timeoutMs?: number;
  dedupe?: DelegateAndWaitDedupeInput;
}

export interface DelegateAndWaitDedupeInput {
  titleContains: string;
  status?: string;
  pageSize?: number;
  includeArchive?: boolean;
  excludeEmpty?: boolean;
  reuseIfStatus?: string[];
  matchAnyCwd?: boolean;
  includeSummary?: boolean;
}

export interface WaitUntilIdleInput {
  sessionId: string;
  timeoutMs?: number;
}

export interface GetHandoffInput {
  sessionId: string;
}

export interface ReviewPackageInput {
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

export interface RecentSessionsInput {
  pageSize?: number;
  status?: string;
  includeArchive?: boolean;
  excludeEmpty?: boolean;
}

export interface FindRecentSessionInput {
  titleContains: string;
  status?: string;
  pageSize?: number;
  includeArchive?: boolean;
  excludeEmpty?: boolean;
  cwd?: string;
  matchAnyCwd?: boolean;
  includeSummary?: boolean;
}

export interface FindRecentSessionResult {
  query: Omit<FindRecentSessionInput, 'titleContains'> & { titleContains: string };
  match?: RecentSession;
  candidates: RecentSession[];
  skippedCandidates?: RecentSession[];
  suggestedNextActions: string[];
}

export interface RecentSessionsResult {
  items: RecentSession[];
}

export interface DelegateAndWaitResult {
  sessionId: string;
  promptId: string;
  submitStatus: string;
  webUrl: string;
  wait: WaitUntilIdleResult;
  handoff?: KimiHandoff;
  changedFiles?: string[];
  reviewPackage?: ReviewPackageResult;
  diagnostics?: DelegateAndWaitDiagnostics;
  dedupe?: DelegateAndWaitDedupeResult;
}

export interface DelegateAndWaitDedupeResult {
  checked: true;
  matched: boolean;
  reused: boolean;
  cwdMatched?: boolean;
  reason?: string;
  match?: RecentSession;
  skippedCandidates?: RecentSession[];
  query?: FindRecentSessionResult['query'];
  suggestedNextActions: string[];
}

export interface DelegateAndWaitDiagnostics {
  recentMessages: Array<{ role: string; content: string }>;
  lastAssistantMessage: string;
  suggestedNextActions: string[];
  messagesUnavailable?: boolean;
  messageError?: string;
}

export interface ReviewPackageResult {
  sessionId: string;
  webUrl: string;
  handoff: KimiHandoff;
  changedFiles: string[];
  diffStats: {
    filesChanged: number;
    additions: number;
    deletions: number;
    diffsWithContent: number;
    committed: {
      available: boolean;
      filesChanged: number;
      additions: number;
      deletions: number;
      commits: number;
      unavailableReason?: string;
    };
    workingTree: {
      available: boolean;
      filesChanged: number;
      additions: number;
      deletions: number;
    };
  };
  reviewChecklist: string[];
}

export interface ToolHandlers {
  kimi_delegate_task: (input: DelegateTaskInput) => Promise<{ sessionId: string; promptId: string; status: string; webUrl: string }>;
  kimi_delegate_and_wait: (input: DelegateAndWaitInput) => Promise<DelegateAndWaitResult>;
  kimi_wait_until_idle: (input: WaitUntilIdleInput) => Promise<WaitUntilIdleResult>;
  kimi_get_handoff: (input: GetHandoffInput) => Promise<KimiHandoff>;
  kimi_review_package: (input: ReviewPackageInput) => Promise<ReviewPackageResult>;
  kimi_continue_task: (input: ContinueTaskInput) => Promise<{ sessionId: string; promptId: string; status: string; webUrl: string }>;
  kimi_get_diff: (input: GetDiffInput) => Promise<{ path: string; diff: string }>;
  kimi_abort: (input: AbortInput) => Promise<{ sessionId: string; aborted: true }>;
  kimi_bridge_status: () => Promise<BridgeStatus>;
  kimi_recent_sessions: (input: RecentSessionsInput) => Promise<RecentSessionsResult>;
  kimi_find_recent_session: (input: FindRecentSessionInput) => Promise<FindRecentSessionResult>;
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

function buildWebUrl(serverUrl: string, sessionId: string): string {
  return `${serverUrl}/sessions/${encodeURIComponent(sessionId)}`;
}

function baselineMetadata(baseline: GitBaseline): Record<string, unknown> {
  const codexKimiBridge: Record<string, unknown> = {
    schema_version: 1,
    base_commit: baseline.baseCommit,
    ...(baseline.baseBranch ? { base_branch: baseline.baseBranch } : {}),
    initial_dirty_paths: baseline.initialDirtyPaths,
  };
  if (baseline.worktrees && baseline.worktrees.length > 0) {
    codexKimiBridge.worktrees = baseline.worktrees.map((wt) => ({
      path: wt.path,
      head_commit: wt.headCommit,
    }));
  }
  return { codex_kimi_bridge: codexKimiBridge };
}

function parseBaselineMetadata(metadata: Record<string, unknown> | undefined): GitBaseline | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const bridge = metadata.codex_kimi_bridge;
  if (!bridge || typeof bridge !== 'object' || (bridge as Record<string, unknown>).schema_version !== 1) {
    return undefined;
  }
  const bridgeObj = bridge as Record<string, unknown>;
  const baseCommit = typeof bridgeObj.base_commit === 'string' ? bridgeObj.base_commit : undefined;
  if (!baseCommit || !OBJECT_ID_RE.test(baseCommit)) return undefined;
  const baseBranch = typeof bridgeObj.base_branch === 'string' ? bridgeObj.base_branch : undefined;
  const initialDirtyPaths = Array.isArray(bridgeObj.initial_dirty_paths)
    ? bridgeObj.initial_dirty_paths.filter((p): p is string => typeof p === 'string')
    : [];
  const worktreesRaw = bridgeObj.worktrees;
  const worktrees = Array.isArray(worktreesRaw)
    ? worktreesRaw
        .map((item) => {
          if (!item || typeof item !== 'object') return undefined;
          const wt = item as Record<string, unknown>;
          const wtPath = typeof wt.path === 'string' ? wt.path : undefined;
          const headCommit = typeof wt.head_commit === 'string' ? wt.head_commit : undefined;
          if (!wtPath || !headCommit) return undefined;
          return { path: wtPath, headCommit };
        })
        .filter((wt): wt is NonNullable<typeof wt> => wt !== undefined)
    : undefined;
  return {
    schemaVersion: 1,
    baseCommit,
    baseBranch,
    initialDirtyPaths,
    worktrees,
  };
}

function normalizeCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const normalized = path.normalize(cwd);
  // Strip trailing slash except for root '/', so '/repo' and '/repo/' compare equal.
  return normalized.endsWith('/') && normalized.length > 1 ? normalized.slice(0, -1) : normalized;
}

function buildRecentSession(serverUrl: string, session: RuntimeSession & { created_at?: string; updated_at?: string }, serverToken: string | undefined): RecentSession {
  return {
    sessionId: session.id,
    status: session.status,
    title: sanitizeDiagnosticText(session.title, serverToken),
    webUrl: buildWebUrl(serverUrl, session.id),
    cwd: sanitizeDiagnosticText(session.metadata.cwd, serverToken),
    ...(session.created_at ? { createdAt: session.created_at } : {}),
    ...(session.updated_at ? { updatedAt: session.updated_at } : {}),
  };
}

function buildFindSuggestions(match: RecentSession): string[] {
  switch (match.status) {
    case 'running':
      return [
        `找到正在运行的 session ${match.sessionId}。`,
        `调用 kimi_wait_until_idle 继续等待，或在浏览器中打开 ${match.webUrl} 查看实时进度。`,
      ];
    case 'idle':
      return [
        `找到已空闲的 session ${match.sessionId}。`,
        `调用 kimi_review_package 获取 review package，或在浏览器中打开 ${match.webUrl} 查看结果。`,
      ];
    case 'aborted':
      return [
        `找到已中断的 session ${match.sessionId}。`,
        `在浏览器中打开 ${match.webUrl} 查看中断原因。`,
        '必要时使用 kimi_continue_task 继续旧 session，而不是直接重新 delegate。',
      ];
    case 'failed':
      return [
        `找到执行失败的 session ${match.sessionId}。`,
        `在浏览器中打开 ${match.webUrl} 查看失败原因。`,
        '修正原因后使用 kimi_continue_task 继续旧 session，不要自动创建重复 session。',
      ];
    case 'awaiting_approval':
      return [
        `找到等待审批的 session ${match.sessionId}。`,
        `在浏览器中打开 ${match.webUrl} 处理 approval，处理后继续等待或调用 kimi_wait_until_idle。`,
      ];
    case 'awaiting_question':
      return [
        `找到等待回答的 session ${match.sessionId}。`,
        `在浏览器中打开 ${match.webUrl} 回答问题，处理后继续等待或调用 kimi_wait_until_idle。`,
      ];
    default:
      return [
        `找到 session ${match.sessionId}，状态为 ${match.status}。`,
        `在浏览器中打开 ${match.webUrl} 查看详情。`,
      ];
  }
}

const MESSAGE_TRUNCATION_LIMIT = 1000;

function truncateMessage(content: string): string {
  if (content.length <= MESSAGE_TRUNCATION_LIMIT) return content;
  return `${content.slice(0, MESSAGE_TRUNCATION_LIMIT)}...`;
}

async function buildRecentSessionSummary(
  kimi: KimiClient,
  sessionId: string,
  serverToken: string | undefined,
): Promise<RecentSessionSummary> {
  try {
    const messages = await kimi.listMessages(sessionId);
    const lastUserMessage = selectLatestMeaningfulMessage(
      messages,
      'user',
      serverToken,
      MESSAGE_TRUNCATION_LIMIT,
    );
    const lastAssistantMessage = selectLatestMeaningfulMessage(
      messages,
      'assistant',
      serverToken,
      MESSAGE_TRUNCATION_LIMIT,
    );
    return {
      messageCount: messages.length,
      ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
      ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
    };
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    return {
      messagesUnavailable: true,
      messageError: sanitizeDiagnosticText(rawError, serverToken),
    };
  }
}

interface FindRecentSessionByTitleResult {
  query: FindRecentSessionResult['query'];
  candidates: RecentSession[];
  skippedCandidates?: RecentSession[];
  match?: RecentSession;
  suggestedNextActions: string[];
}

async function findRecentSessionByTitle(
  deps: ToolDeps,
  input: FindRecentSessionInput,
): Promise<FindRecentSessionByTitleResult> {
  const titleContains = input.titleContains.trim();
  if (titleContains.length === 0) {
    throw new Error('titleContains 不能为空或仅包含空白字符。');
  }
  const safeTitleContains = sanitizeDiagnosticText(titleContains, deps.config.serverToken);

  const result = await deps.kimi.listSessions({
    pageSize: input.pageSize ?? 20,
    status: input.status,
    includeArchive: input.includeArchive,
    excludeEmpty: input.excludeEmpty,
  });

  const normalizedQuery = titleContains.toLowerCase();
  const titleMatchedSessions = result.items.filter((session) =>
    session.title.toLowerCase().includes(normalizedQuery),
  );

  const targetCwd = normalizeCwd(input.cwd);
  const filterByCwd = targetCwd !== undefined && input.matchAnyCwd !== true;

  let candidateSessions: typeof titleMatchedSessions;
  let skippedSessions: typeof titleMatchedSessions | undefined;
  if (filterByCwd) {
    candidateSessions = titleMatchedSessions.filter((session) => normalizeCwd(session.metadata.cwd) === targetCwd);
    skippedSessions = titleMatchedSessions.filter((session) => normalizeCwd(session.metadata.cwd) !== targetCwd);
  } else {
    candidateSessions = titleMatchedSessions;
    skippedSessions = undefined;
  }

  const candidates = candidateSessions.map((session) => buildRecentSession(deps.config.serverUrl, session, deps.config.serverToken));
  const skippedCandidates = skippedSessions?.map((session) => buildRecentSession(deps.config.serverUrl, session, deps.config.serverToken));

  if (input.includeSummary) {
    for (const candidate of candidates) {
      candidate.summary = await buildRecentSessionSummary(deps.kimi, candidate.sessionId, deps.config.serverToken);
    }
    if (skippedCandidates) {
      for (const candidate of skippedCandidates) {
        candidate.summary = await buildRecentSessionSummary(deps.kimi, candidate.sessionId, deps.config.serverToken);
      }
    }
  }

  const match = candidates[0];

  const suggestedNextActions = match
    ? buildFindSuggestions(match)
    : [
        `未找到标题包含 "${safeTitleContains}" 的 session。`,
        '尝试放宽关键词（例如去掉日期、版本号），或调用 kimi_recent_sessions 查看最近 session 列表。',
        '确认无重复/遗留 session 后再新建任务，避免直接重新 delegate 造成重复。',
      ];

  return {
    query: {
      titleContains: safeTitleContains,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      ...(input.includeArchive !== undefined ? { includeArchive: input.includeArchive } : {}),
      ...(input.excludeEmpty !== undefined ? { excludeEmpty: input.excludeEmpty } : {}),
      ...(input.cwd !== undefined ? { cwd: sanitizeDiagnosticText(input.cwd, deps.config.serverToken) } : {}),
      ...(input.matchAnyCwd !== undefined ? { matchAnyCwd: input.matchAnyCwd } : {}),
      ...(input.includeSummary !== undefined ? { includeSummary: input.includeSummary } : {}),
    },
    candidates,
    ...(skippedCandidates && skippedCandidates.length > 0 ? { skippedCandidates } : {}),
    ...(match ? { match } : {}),
    suggestedNextActions,
  };
}

async function buildDelegateAndWaitDiagnostics(
  kimi: KimiClient,
  sessionId: string,
  status: 'timeout' | 'aborted' | 'failed',
  webUrl: string,
  serverToken: string | undefined,
): Promise<DelegateAndWaitDiagnostics> {
  let recentMessages: Array<{ role: string; content: string }> = [];
  let lastAssistantMessage = '';
  let messagesUnavailable = false;
  let messageError: string | undefined;

  try {
    const allMessages = await kimi.listMessages(sessionId);
    recentMessages = allMessages.slice(-3).map((message) => ({
      role: message.role,
      content: truncateMessage(sanitizeDiagnosticText(message.content, serverToken)),
    }));
    for (let i = recentMessages.length - 1; i >= 0; i--) {
      if (recentMessages[i].role === 'assistant') {
        lastAssistantMessage = recentMessages[i].content;
        break;
      }
    }
  } catch (err) {
    messagesUnavailable = true;
    const rawError = err instanceof Error ? err.message : String(err);
    messageError = sanitizeDiagnosticText(rawError, serverToken);
  }

  const suggestedNextActions = status === 'timeout'
    ? [
        'wait 状态为 timeout，可继续调用 kimi_wait_until_idle 等待同一 session。',
        `或在浏览器中打开 webUrl ${webUrl} 查看实时进度。`,
      ]
    : status === 'failed'
      ? [
          'wait 状态为 failed，请在浏览器中打开 webUrl 查看失败原因。',
          `webUrl: ${webUrl}`,
          '修正原因后使用 kimi_continue_task 继续同一 session。',
        ]
      : [
          'wait 状态为 aborted，可在浏览器中打开 webUrl 查看中断原因。',
          `webUrl: ${webUrl}`,
          '必要时使用 kimi_continue_task 重试或补充指令。',
        ];

  return {
    recentMessages,
    lastAssistantMessage,
    suggestedNextActions,
    ...(messagesUnavailable ? { messagesUnavailable } : {}),
    ...(messageError ? { messageError } : {}),
  };
}

const defaultFileLister: FileLister = {
  async listFiles(baseDir: string, relativeDir: string): Promise<string[]> {
    const fullDir = path.join(baseDir, relativeDir);
    const entries = await readdir(fullDir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const childRelativePath = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.listFiles(baseDir, childRelativePath));
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(childRelativePath);
      }
    }
    return files;
  },
};

export function createToolHandlers(deps: ToolDeps): ToolHandlers {
  const gitInspector = deps.gitInspector ?? new NodeGitInspector();

  function buildReviewPackage(sessionId: string, handoff: KimiHandoff): ReviewPackageResult {
    const diffsWithContent = handoff.diffs.filter((d) => d.diff.length > 0).length;
    const committed = handoff.committedChanges;
    const workingTree = handoff.workingTreeChanges;
    return {
      sessionId,
      webUrl: buildWebUrl(deps.config.serverUrl, sessionId),
      handoff,
      changedFiles: handoff.changedFiles,
      diffStats: {
        filesChanged: handoff.changedFiles.length,
        additions: handoff.additions,
        deletions: handoff.deletions,
        diffsWithContent,
        committed: {
          available: committed.available,
          filesChanged: committed.changedFiles.length,
          additions: committed.additions,
          deletions: committed.deletions,
          commits: handoff.commits.length,
          unavailableReason: committed.unavailableReason,
        },
        workingTree: {
          available: workingTree.available,
          filesChanged: workingTree.changedFiles.length,
          additions: workingTree.additions,
          deletions: workingTree.deletions,
        },
      },
      reviewChecklist: [
        '检查 committedChanges：Kimi 从 baseCommit 到 HEAD 的提交证据',
        '检查 workingTreeChanges：当前工作区/暂存区改动',
        '检查 initialDirtyPaths： delegation 前已存在的未提交改动',
        '若 committedChanges.available 为 false，按 unavailableReason 直接 git log/git diff 核查',
        '不要仅因 working tree 干净就推断没有改动',
        '必要时继续调用 kimi_continue_task',
      ],
    };
  }

  async function buildDelegateAndWaitResult(
    delegated: { sessionId: string; promptId: string; status: string; webUrl: string },
    wait: WaitUntilIdleResult,
  ): Promise<DelegateAndWaitResult> {
    if (wait.status !== 'idle') {
      const result: DelegateAndWaitResult = {
        sessionId: delegated.sessionId,
        promptId: delegated.promptId,
        submitStatus: delegated.status,
        webUrl: delegated.webUrl,
        wait,
      };
      if (wait.status === 'timeout' || wait.status === 'aborted' || wait.status === 'failed') {
        result.diagnostics = await buildDelegateAndWaitDiagnostics(
          deps.kimi,
          delegated.sessionId,
          wait.status,
          delegated.webUrl,
          deps.config.serverToken,
        );
      }
      return result;
    }
    const handoff = await handlers.kimi_get_handoff({ sessionId: delegated.sessionId });
    const reviewPackage = buildReviewPackage(delegated.sessionId, handoff);
    return {
      sessionId: delegated.sessionId,
      promptId: delegated.promptId,
      submitStatus: delegated.status,
      webUrl: delegated.webUrl,
      wait,
      handoff,
      changedFiles: handoff.changedFiles,
      reviewPackage,
    };
  }

  const handlers: ToolHandlers = {
    async kimi_bridge_status() {
      const status = await deps.preflight.getStatus();
      if (!status.healthzOk || !status.authOk) return status;
      try {
        const meta = await deps.kimi.getMeta();
        return {
          ...status,
          ...(meta.server_version ? { serverVersion: meta.server_version } : {}),
          ...(meta.backend ? { backend: meta.backend } : {}),
        };
      } catch {
        return {
          ...status,
          diagnostics: [...status.diagnostics, 'meta unavailable'],
        };
      }
    },

    async kimi_recent_sessions(input: RecentSessionsInput) {
      const result = await deps.kimi.listSessions({
        pageSize: input.pageSize ?? 10,
        status: input.status,
        includeArchive: input.includeArchive,
        excludeEmpty: input.excludeEmpty,
      });
      return {
        items: result.items.map((session) => buildRecentSession(deps.config.serverUrl, session, deps.config.serverToken)),
      };
    },

    async kimi_find_recent_session(input: FindRecentSessionInput) {
      return findRecentSessionByTitle(deps, input);
    },

    async kimi_delegate_task(input: DelegateTaskInput) {
      let session: { id: string };
      if (input.sessionId) {
        session = { id: input.sessionId };
      } else {
        let metadata: Record<string, unknown> | undefined;
        try {
          const baselineResult = await gitInspector.captureBaseline(input.cwd);
          if (baselineResult.available) {
            metadata = baselineMetadata(baselineResult.baseline);
          }
        } catch {
          // Failure to inspect Git must not prevent delegation.
        }
        session = await deps.kimi.createSession({ cwd: input.cwd, title: input.task.slice(0, 80), metadata });
      }
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
      return { sessionId: session.id, promptId: result.prompt_id, status: result.status, webUrl: buildWebUrl(deps.config.serverUrl, session.id) };
    },

    async kimi_delegate_and_wait(input: DelegateAndWaitInput) {
      const supportedDedupeReuseStatuses: Array<RecentSession['status']> = ['running', 'idle', 'awaiting_approval', 'awaiting_question'];
      const defaultReusableStatuses: string[] = supportedDedupeReuseStatuses;

      if (input.dedupe) {
        const dedupeInput = input.dedupe;
        const findResult = await findRecentSessionByTitle(deps, {
          titleContains: dedupeInput.titleContains,
          status: dedupeInput.status,
          pageSize: dedupeInput.pageSize,
          includeArchive: dedupeInput.includeArchive,
          excludeEmpty: dedupeInput.excludeEmpty,
          cwd: input.cwd,
          matchAnyCwd: dedupeInput.matchAnyCwd,
          includeSummary: dedupeInput.includeSummary,
        });

        const reuseIfStatus = dedupeInput.reuseIfStatus ?? defaultReusableStatuses;
        const match = findResult.match;
        const userAllowsReuse = match && reuseIfStatus.includes(match.status);
        const bridgeSupportsReuse = match && supportedDedupeReuseStatuses.includes(match.status);
        const canReuse = userAllowsReuse && bridgeSupportsReuse;
        const cwdMatched = match !== undefined
          ? normalizeCwd(match.cwd) === normalizeCwd(input.cwd)
          : (findResult.skippedCandidates && findResult.skippedCandidates.length > 0 ? false : undefined);

        if (canReuse) {
          const baseDedupe: DelegateAndWaitDedupeResult = {
            checked: true,
            matched: true,
            reused: true,
            cwdMatched,
            match,
            query: findResult.query,
            suggestedNextActions: findResult.suggestedNextActions,
          };

          if (match.status === 'running') {
            return {
              sessionId: match.sessionId,
              promptId: '',
              submitStatus: 'reused',
              webUrl: match.webUrl,
              wait: { status: 'running' },
              dedupe: { ...baseDedupe, reason: 'running' },
            };
          }

          if (match.status === 'idle') {
            const handoff = await handlers.kimi_get_handoff({ sessionId: match.sessionId });
            const reviewPackage = buildReviewPackage(match.sessionId, handoff);
            return {
              sessionId: match.sessionId,
              promptId: '',
              submitStatus: 'reused',
              webUrl: match.webUrl,
              wait: { status: 'idle' },
              handoff,
              changedFiles: handoff.changedFiles,
              reviewPackage,
              dedupe: { ...baseDedupe, reason: 'idle' },
            };
          }

          if (match.status === 'awaiting_approval' || match.status === 'awaiting_question') {
            const wait = await handlers.kimi_wait_until_idle({
              sessionId: match.sessionId,
              timeoutMs: 0,
            });
            return {
              sessionId: match.sessionId,
              promptId: '',
              submitStatus: 'reused',
              webUrl: match.webUrl,
              wait,
              dedupe: { ...baseDedupe, reason: match.status },
            };
          }
        }

        const delegated = await handlers.kimi_delegate_task(input);
        const wait = await handlers.kimi_wait_until_idle({
          sessionId: delegated.sessionId,
          timeoutMs: input.timeoutMs,
        });
        const baseResult = await buildDelegateAndWaitResult(delegated, wait);

        let reason: string | undefined;
        if (match) {
          reason = bridgeSupportsReuse ? 'status_not_reusable' : 'status_not_supported';
        } else if (findResult.skippedCandidates && findResult.skippedCandidates.length > 0) {
          reason = 'cwd_mismatch';
        }

        return {
          ...baseResult,
          dedupe: {
            checked: true,
            matched: !!match,
            reused: false,
            cwdMatched,
            ...(match ? { match } : {}),
            ...(findResult.skippedCandidates && findResult.skippedCandidates.length > 0 ? { skippedCandidates: findResult.skippedCandidates } : {}),
            ...(reason ? { reason } : {}),
            query: findResult.query,
            suggestedNextActions: findResult.suggestedNextActions,
          },
        };
      }

      const delegated = await handlers.kimi_delegate_task(input);
      const wait = await handlers.kimi_wait_until_idle({
        sessionId: delegated.sessionId,
        timeoutMs: input.timeoutMs,
      });
      return buildDelegateAndWaitResult(delegated, wait);
    },

    async kimi_wait_until_idle(input: WaitUntilIdleInput) {
      const result = await waitUntilIdle({
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs ?? deps.config.requestTimeoutMs,
        pollStatus: async () => ({ status: await deps.kimi.getRuntimeStatus(input.sessionId) }),
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
      const [messages, gitStatus, session] = await Promise.all([
        deps.kimi.listMessages(input.sessionId),
        deps.kimi.getGitStatus(input.sessionId),
        deps.kimi.getSession(input.sessionId),
      ]);

      const fileLister = deps.fileLister ?? defaultFileLister;
      const workingTreeFiles = await expandGitStatusEntries({
        entries: gitStatus.entries,
        baseDir: session.metadata.cwd,
        listFiles: fileLister.listFiles.bind(fileLister),
      });

      const workingTreeDiffs = await Promise.all(
        workingTreeFiles.map((path) => deps.kimi.getFileDiff(input.sessionId, path)),
      );

      const baseline = parseBaselineMetadata(session.metadata);
      let committedResult:
        | { baseCommit?: string; headCommit?: string; reviewWorkspace?: string; commits: Awaited<ReturnType<GitInspector['collectCommittedChanges']>>['commits']; changeSet: Awaited<ReturnType<GitInspector['collectCommittedChanges']>>['changeSet']; diagnostics?: unknown }
        | undefined;
      try {
        committedResult = await gitInspector.collectCommittedChanges(session.metadata.cwd, baseline);
      } catch {
        // Committed inspection failure must not discard working-tree evidence.
      }

      const sessionCwd = session.metadata.cwd;
      const reviewWorkspace = committedResult?.reviewWorkspace;
      const workingTreeChanges: HandoffChangeSet =
        reviewWorkspace && reviewWorkspace !== sessionCwd
          ? {
              available: false,
              changedFiles: [],
              additions: 0,
              deletions: 0,
              diffs: [],
              truncatedPaths: [],
              unavailableReason: 'review_workspace_mismatch',
            }
          : {
              available: true,
              changedFiles: workingTreeFiles,
              additions: gitStatus.additions,
              deletions: gitStatus.deletions,
              diffs: workingTreeDiffs.map((item) => ({ ...item, source: 'working_tree' as const })),
              truncatedPaths: [],
            };

      return buildHandoff({
        messages,
        waitStatus: session.status,
        serverToken: deps.config.serverToken,
        baseCommit: committedResult?.baseCommit,
        headCommit: committedResult?.headCommit,
        reviewWorkspace: committedResult?.reviewWorkspace,
        commits: committedResult?.commits ?? [],
        initialDirtyPaths: baseline?.initialDirtyPaths ?? [],
        committedChanges: committedResult?.changeSet ?? {
          available: false,
          changedFiles: [],
          additions: 0,
          deletions: 0,
          diffs: [],
          truncatedPaths: [],
          unavailableReason: baseline === undefined ? 'baseline_unavailable' : 'git_command_failed',
        },
        workingTreeChanges,
        committedDiagnostics: committedResult?.diagnostics,
      });
    },

    async kimi_review_package(input: ReviewPackageInput) {
      const handoff = await handlers.kimi_get_handoff(input);
      return buildReviewPackage(input.sessionId, handoff);
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
      return { sessionId: input.sessionId, promptId: result.prompt_id, status: result.status, webUrl: buildWebUrl(deps.config.serverUrl, input.sessionId) };
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
    kimi_delegate_and_wait: withPreflight(deps.preflight, handlers.kimi_delegate_and_wait),
    kimi_wait_until_idle: withPreflight(deps.preflight, handlers.kimi_wait_until_idle),
    kimi_get_handoff: withPreflight(deps.preflight, handlers.kimi_get_handoff),
    kimi_review_package: withPreflight(deps.preflight, handlers.kimi_review_package),
    kimi_continue_task: withPreflight(deps.preflight, handlers.kimi_continue_task),
    kimi_get_diff: withPreflight(deps.preflight, handlers.kimi_get_diff),
    kimi_abort: withPreflight(deps.preflight, handlers.kimi_abort),
    kimi_recent_sessions: withPreflight(deps.preflight, handlers.kimi_recent_sessions),
    kimi_find_recent_session: withPreflight(deps.preflight, handlers.kimi_find_recent_session),
  };
}
