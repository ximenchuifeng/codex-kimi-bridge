import { spawn as defaultSpawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { resolveServerToken, type BridgeConfig, type TokenSource } from './config.js';
import { KimiApiError, KimiNetworkError } from './errors.js';
import type { KimiHttpClient } from './kimi/http.js';

export interface BridgeStatus {
  serverUrl: string;
  healthzOk: boolean;
  authOk: boolean;
  tokenSource: TokenSource;
  autoStart: boolean;
  kimiCommand: string;
  diagnostics: string[];
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

function defaultResolveToken(config: BridgeConfig): { token?: string; source: TokenSource } {
  return resolveServerToken(config.serverToken, config.kimiCodeHome, homedir());
}

export class KimiPreflight {
  private readonly spawnImpl: NonNullable<PreflightOptions['spawn']>;
  private readonly resolveToken: NonNullable<PreflightOptions['resolveToken']>;
  private readonly now: NonNullable<PreflightOptions['now']>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;

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

    return status;
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.checkOnce();
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
    return {
      serverUrl: this.config.serverUrl,
      healthzOk,
      authOk,
      tokenSource: this.config.serverTokenSource,
      autoStart: this.config.autoStart,
      kimiCommand: this.config.kimiCommand,
      diagnostics,
    };
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
