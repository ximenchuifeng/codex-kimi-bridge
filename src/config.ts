export interface BridgeConfig {
  serverUrl: string;
  defaultModel?: string;
  defaultThinking: string;
  defaultPermissionMode: 'manual' | 'auto' | 'yolo';
  requestTimeoutMs: number;
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

export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const permission = env.KIMI_PERMISSION_MODE;
  const defaultPermissionMode =
    permission === 'manual' || permission === 'auto' || permission === 'yolo'
      ? permission
      : 'auto';

  return {
    serverUrl: normalizeServerUrl(env.KIMI_SERVER_URL ?? 'http://127.0.0.1:58627'),
    defaultModel: env.KIMI_MODEL && env.KIMI_MODEL.trim().length > 0 ? env.KIMI_MODEL : undefined,
    defaultThinking: env.KIMI_THINKING && env.KIMI_THINKING.trim().length > 0 ? env.KIMI_THINKING : 'high',
    defaultPermissionMode,
    requestTimeoutMs: parseRequestTimeoutMs(env.KIMI_REQUEST_TIMEOUT_MS),
  };
}
