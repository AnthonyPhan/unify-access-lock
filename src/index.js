import { resolve } from "node:path";
import { ConfigManager } from "./config-manager.js";
import { ConfigStore } from "./config-store.js";
import { loadEnvFile } from "./env.js";
import { logger } from "./logger.js";
import { RuntimeManager } from "./runtime-manager.js";
import { createServer } from "./server.js";

function setupPort(environment) {
  const value = Number(environment.SETUP_PORT || environment.PORT || 8_080);
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535 ? value : 8_080;
}

async function main() {
  loadEnvFile();
  const configPath = process.env.CONFIG_PATH || resolve("data/config.json");
  const configManager = new ConfigManager({ store: new ConfigStore(configPath) });
  await configManager.load();

  const initial = configManager.tryConfig();
  const actualPort = initial.config?.server.port ?? setupPort(process.env);
  const runtime = new RuntimeManager({ logger });
  const server = createServer({ configManager, runtime, actualPort, logger });

  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(actualPort, "0.0.0.0", resolveListening);
  });

  logger.info("Configuration web app is ready", {
    url: `http://0.0.0.0:${actualPort}`,
    authenticationConfigured: configManager.authenticationConfigured(),
  });

  if (initial.config) {
    void runtime.configure(initial.config);
  } else {
    logger.warn("Automation is waiting for configuration", { reason: initial.error });
  }

  const shutdown = (signal) => {
    logger.info("Shutting down", { signal });
    runtime.stop();
    server.close((error) => {
      if (error) {
        logger.error("HTTP server shutdown failed", { error: error.message });
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  logger.error("Service failed to start", { error: error.message });
  process.exitCode = 1;
});
