import { loadBridgeConfig } from '../../src/config.js';
import { KimiHttpClient } from '../../src/kimi/http.js';
import { KimiClient } from '../../src/kimi/client.js';
import { KimiPreflight } from '../../src/preflight.js';
import { FileBaselineStore } from '../../src/baseline-store.js';
import { createToolHandlers } from '../../src/tools.js';

async function main() {
  const serverUrl = process.env.KIMI_SERVER_URL;
  const stateDir = process.env.KIMI_BRIDGE_STATE_DIR;
  const sessionId = process.env.SESSION_ID;
  if (!serverUrl || !stateDir || !sessionId) {
    throw new Error('KIMI_SERVER_URL, KIMI_BRIDGE_STATE_DIR, and SESSION_ID are required');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KIMI_SERVER_URL: serverUrl,
    KIMI_BRIDGE_STATE_DIR: stateDir,
  };
  delete env.KIMI_SERVER_TOKEN;

  const config = loadBridgeConfig(env);
  const http = new KimiHttpClient(config.serverUrl, fetch, config.requestTimeoutMs, config.serverToken);
  const preflight = new KimiPreflight(config, http);
  const kimi = new KimiClient(http);
  const baselineStore = new FileBaselineStore({ stateDir: config.stateDir, serverUrl: config.serverUrl });
  const handlers = createToolHandlers({ kimi, config, preflight, baselineStore });
  const result = await handlers.kimi_review_package({ sessionId });
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(text);
  process.exit(1);
});
