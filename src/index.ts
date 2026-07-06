import { loadBridgeConfig } from './config.js';

export async function main(): Promise<void> {
  loadBridgeConfig();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
