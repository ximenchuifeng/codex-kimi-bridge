import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type TokenSource = 'env' | 'kimi_code_home' | 'home' | 'none';

export interface BridgeConfig {
  serverUrl: string;
  defaultModel?: string;
  defaultThinking: string;
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  requestTimeoutMs: number;
  serverToken?: string;
  serverTokenSource: TokenSource;
  envServerToken?: string;
  autoStart: boolean;
  kimiCommand: string;
  preflightCacheMs: number;
  kimiCodeHome?: string;
}

function normalizeServerUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function parseRequestTimeoutMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '30000', 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 30000;
  return parsed;
}

function parsePreflightCacheMs(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '5000', 10);
  if (Number.isNaN(parsed) || parsed < 0) return 5000;
  return parsed;
}

export function resolveServerToken(
  envToken: string | undefined,
  kimiCodeHome: string | undefined,
  homeDir: string = homedir(),
): { token?: string; source: TokenSource } {
  const trimmedEnv = envToken?.trim();
  if (trimmedEnv && trimmedEnv.length > 0) {
    return { token: trimmedEnv, source: 'env' };
  }

  const candidates: Array<{ path: string; source: TokenSource }> = [
    ...(kimiCodeHome ? [{ path: join(kimiCodeHome, 'server.token'), source: 'kimi_code_home' as TokenSource }] : []),
    { path: join(homeDir, '.kimi-code', 'server.token'), source: 'home' },
  ];

  for (const candidate of candidates) {
    try {
      const fileToken = readFileSync(candidate.path, 'utf-8').trim();
      if (fileToken.length > 0) return { token: fileToken, source: candidate.source };
    } catch {
      // continue to next candidate
    }
  }

  return { source: 'none' };
}

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const permission = env.KIMI_PERMISSION_MODE;
  const defaultPermissionMode =
    permission === 'manual' || permission === 'auto' || permission === 'yolo'
      ? permission
      : 'auto';

  const kimiCodeHome = env.KIMI_CODE_HOME && env.KIMI_CODE_HOME.trim().length > 0 ? env.KIMI_CODE_HOME.trim() : undefined;
  const { token, source } = resolveServerToken(env.KIMI_SERVER_TOKEN, kimiCodeHome);

  return {
    serverUrl: normalizeServerUrl(env.KIMI_SERVER_URL ?? 'http://127.0.0.1:58627'),
    defaultModel: env.KIMI_MODEL && env.KIMI_MODEL.trim().length > 0 ? env.KIMI_MODEL : undefined,
    defaultThinking: env.KIMI_THINKING && env.KIMI_THINKING.trim().length > 0 ? env.KIMI_THINKING : 'high',
    defaultPermissionMode,
    requestTimeoutMs: parseRequestTimeoutMs(env.KIMI_REQUEST_TIMEOUT_MS),
    serverToken: token,
    serverTokenSource: source,
    envServerToken: env.KIMI_SERVER_TOKEN,
    autoStart: !(env.KIMI_AUTO_START === 'false' || env.KIMI_AUTO_START === '0'),
    kimiCommand: env.KIMI_COMMAND && env.KIMI_COMMAND.trim().length > 0 ? env.KIMI_COMMAND.trim() : 'kimi',
    preflightCacheMs: parsePreflightCacheMs(env.KIMI_PREFLIGHT_CACHE_MS),
    kimiCodeHome,
  };
}
