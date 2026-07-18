import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveServerToken, type BridgeConfig, type TokenSource } from './config.js';
import { KimiApiError, KimiNetworkError } from './errors.js';
import type { KimiHttpClient } from './kimi/http.js';

export interface BridgeStatus {
  serverUrl: string;
  webBaseUrl: string;
  canOpenWeb: boolean;
  healthzOk: boolean;
  authOk: boolean;
  status: 'ready' | 'server_unreachable' | 'auth_failed';
  tokenSource: TokenSource;
  autoStart: boolean;
  kimiCommand: string;
  preflightCacheMs: number;
  cacheFresh?: boolean;
  cacheAgeMs?: number;
  cachedUntil?: number;
  diagnostics: string[];
  nextActions: string[];
  commands?: string[];
  serverVersion?: string;
  backend?: string;
}

export interface PreflightOptions {
  spawn?: (command: string, args: readonly string[], options: { detached: boolean; stdio: 'ignore' }) => ChildProcess;
  resolveToken?: (config: BridgeConfig) => { token?: string; source: TokenSource };
  now?: () => number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function defaultResolveToken(config: BridgeConfig): { token?: string; source: TokenSource } {
  return resolveServerToken(config.envServerToken, config.kimiCodeHome, homedir());
}

export class KimiPreflight {
  private readonly spawnImpl: NonNullable<PreflightOptions['spawn']>;
  private readonly resolveToken: NonNullable<PreflightOptions['resolveToken']>;
  private readonly now: NonNullable<PreflightOptions['now']>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private lastSuccessStatus?: BridgeStatus;
  private lastSuccessAt?: number;

  constructor(
    private readonly config: BridgeConfig,
    private readonly http: KimiHttpClient,
    options: PreflightOptions = {},
  ) {
    this.spawnImpl = options.spawn ?? defaultSpawn;
    this.resolveToken = options.resolveToken ?? defaultResolveToken;
    this.now = options.now ?? Date.now;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async ensureReady(): Promise<BridgeStatus> {
    const cached = this.readCache();
    if (cached) return cached;

    let status = await this.checkOnce();

    if (!status.healthzOk) {
      if (!this.config.autoStart) {
        throw new Error(
          `Kimi server is not reachable at ${this.config.serverUrl} and KIMI_AUTO_START is disabled. ` +
            `Start the server manually or set KIMI_AUTO_START=true.`,
        );
      }
      await this.startServer();
      status = await this.waitForHealthz();
    }

    if (!status.authOk) {
      status = await this.verifyAuthWithRetry();
    }

    if (status.healthzOk && status.authOk) {
      this.writeCache(status);
    }

    return status;
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.checkOnce();
  }

  private readCache(): BridgeStatus | undefined {
    if (this.config.preflightCacheMs <= 0 || !this.lastSuccessStatus || this.lastSuccessAt == null) {
      return undefined;
    }
    const now = this.now();
    const age = now - this.lastSuccessAt;
    if (age > this.config.preflightCacheMs) {
      return undefined;
    }
    return {
      ...this.lastSuccessStatus,
      cacheFresh: true,
      cacheAgeMs: age,
      cachedUntil: this.lastSuccessAt + this.config.preflightCacheMs,
    };
  }

  private writeCache(status: BridgeStatus): void {
    if (this.config.preflightCacheMs <= 0) return;
    this.lastSuccessStatus = status;
    this.lastSuccessAt = this.now();
  }

  private async checkOnce(): Promise<BridgeStatus> {
    const diagnostics: string[] = [];

    let healthzOk = false;
    try {
      await this.http.get('/healthz');
      healthzOk = true;
    } catch (error) {
      diagnostics.push(`healthz failed: ${this.formatError(error)}`);
    }

    let authOk = false;
    if (healthzOk) {
      authOk = await this.checkAuth();
      if (!authOk) diagnostics.push('auth check failed: /config returned an authentication error');
    }

    return this.buildStatus(healthzOk, authOk, diagnostics);
  }

  private buildStatus(healthzOk: boolean, authOk: boolean, diagnostics: string[]): BridgeStatus {
    const status = healthzOk ? (authOk ? 'ready' : 'auth_failed') : 'server_unreachable';
    const webBaseUrl = `${this.config.serverUrl}/`;
    return {
      serverUrl: this.config.serverUrl,
      webBaseUrl,
      canOpenWeb: healthzOk,
      healthzOk,
      authOk,
      status,
      tokenSource: this.config.serverTokenSource,
      autoStart: this.config.autoStart,
      kimiCommand: this.config.kimiCommand,
      preflightCacheMs: this.config.preflightCacheMs,
      cacheFresh: false,
      diagnostics,
      nextActions: this.buildNextActions(status),
      commands: this.buildCommands(status),
    };
  }

  private buildNextActions(status: BridgeStatus['status']): string[] {
    if (status === 'ready') {
      return [
        '可以继续委托任务给 Kimi。',
        '可在浏览器中打开 webBaseUrl，或在任务返回的 webUrl 中查看 session。',
      ];
    }
    if (status === 'server_unreachable') {
      if (this.config.autoStart) {
        return [
          '下一次任务调用会自动尝试启动 Kimi server。',
          '也可以手动运行：kimi server run --keep-alive',
        ];
      }
      return [
        '请手动启动 Kimi server，例如：kimi server run --keep-alive',
        '或设置 KIMI_AUTO_START=true 让 bridge 在需要时自动启动。',
      ];
    }
    return [
      '请检查 KIMI_SERVER_TOKEN 是否有效，以及 bridge 与 Kimi server 使用的 KIMI_CODE_HOME 是否一致。',
      '本地 smoke 测试可临时使用 --dangerous-bypass-auth 启动 Kimi server。',
    ];
  }

  private buildCommands(status: BridgeStatus['status']): string[] {
    if (status === 'ready') {
      return [];
    }

    const commands: string[] = [];

    if (status === 'server_unreachable') {
      if (this.config.autoStart) {
        commands.push(`${shellQuote(this.config.kimiCommand)} server run --keep-alive`);
      } else {
        commands.push(`${shellQuote(this.config.kimiCommand)} server start`);
      }
    }

    if (status === 'auth_failed') {
      commands.push(...this.buildTokenCheckCommands());
    }

    // If the bridge code or plugin config was just changed, rebuilding and reinstalling
    // the local plugin is a safe next step before trying again.
    commands.push('pnpm build');
    commands.push('codex plugin add kimi-delegate@codex-kimi-bridge-local');

    return commands;
  }

  private buildTokenCheckCommands(): string[] {
    const { serverTokenSource, kimiCodeHome } = this.config;

    if (serverTokenSource === 'env') {
      return [
        'echo "KIMI_SERVER_TOKEN is configured via environment; verify it is valid and matches the server."',
      ];
    }

    const check = (path: string) =>
      `test -f ${shellQuote(path)} && echo "token file exists" || echo "token file missing"`;

    if (serverTokenSource === 'kimi_code_home' && kimiCodeHome) {
      return [check(join(kimiCodeHome, 'server.token'))];
    }

    if (serverTokenSource === 'home') {
      return [check(join(homedir(), '.kimi-code', 'server.token'))];
    }

    // No token source known; suggest checking the default file and any custom home.
    const commands = [check(join(homedir(), '.kimi-code', 'server.token'))];
    if (kimiCodeHome) {
      commands.push(check(join(kimiCodeHome, 'server.token')));
    }
    return commands;
  }

  private async checkAuth(): Promise<boolean> {
    try {
      await this.http.get('/config');
      return true;
    } catch {
      return false;
    }
  }

  private async startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      // `kimi server run` keeps the server in the foreground; it does not open a web UI by default,
      // so no --no-open flag is needed.
      const child = this.spawnImpl(this.config.kimiCommand, ['server', 'run', '--keep-alive'], {
        detached: true,
        stdio: 'ignore',
      });

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) {
          reject(error);
        } else {
          child.unref();
          resolve();
        }
      };

      child.on('error', (error) => finish(new Error(`Failed to start Kimi server: ${error.message}`)));
      child.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          finish(new Error(`Kimi server exited with code ${code}. Is '${this.config.kimiCommand}' installed and on PATH?`));
        }
      });

      // Give the spawn a tick to fail immediately; otherwise resolve and let healthz polling detect problems.
      setTimeout(() => finish(), 0);
    });
  }

  private async waitForHealthz(): Promise<BridgeStatus> {
    const deadline = this.now() + this.startupTimeoutMs;
    let lastStatus: BridgeStatus | undefined;

    while (this.now() < deadline) {
      lastStatus = await this.checkOnce();
      if (lastStatus.healthzOk) {
        return lastStatus;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    const diagnostics = lastStatus?.diagnostics ?? ['Kimi server did not become ready in time.'];
    throw new Error(
      `Kimi server did not respond to healthz within ${this.startupTimeoutMs}ms.\n${diagnostics.join('\n')}`,
    );
  }

  private async verifyAuthWithRetry(): Promise<BridgeStatus> {
    let authOk = await this.checkAuth();
    if (authOk) return this.buildStatus(true, true, []);

    const refreshed = this.resolveToken(this.config);
    if (refreshed.token && refreshed.token !== this.config.serverToken) {
      this.http.setServerToken(refreshed.token);
      this.config.serverToken = refreshed.token;
      this.config.serverTokenSource = refreshed.source;
      authOk = await this.checkAuth();
      if (authOk) return this.buildStatus(true, true, []);
    }

    throw new Error(
      `Kimi server authentication failed. The token may be invalid, or the server is using a different KIMI_CODE_HOME. ` +
        `For local smoke testing only, start Kimi with --dangerous-bypass-auth.`,
    );
  }

  private formatError(error: unknown): string {
    if (error instanceof KimiApiError) {
      return `KimiApiError ${error.code}: ${error.message}`;
    }
    if (error instanceof KimiNetworkError) {
      return `KimiNetworkError: ${error.message}`;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }
}
