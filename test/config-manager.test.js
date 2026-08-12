import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ConfigManager } from "../src/config-manager.js";
import { ConfigStore } from "../src/config-store.js";

function form(overrides = {}) {
  return {
    unifiAccessUrl: "https://192.0.2.10:12445",
    apiToken: "api-token",
    tlsRejectUnauthorized: false,
    requestTimeoutMs: 5_000,
    webhookPublicUrl: "http://192.0.2.20:8080/webhooks/unifi",
    webhookPath: "/webhooks/unifi",
    autoRegisterWebhook: true,
    webhookName: "unifi-access-lock",
    webhookSecret: "",
    doorIds: ["door-1"],
    automationEnabled: false,
    lockTimeoutSeconds: 60,
    nativeTriggerSeconds: 1,
    openLockDelayMs: 0,
    signatureToleranceSeconds: 300,
    port: 8_080,
    dryRun: true,
    adminUsername: "admin",
    adminPassword: "a-long-test-password",
    mqttEnabled: false,
    mqttBrokerUrl: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttDiscoveryPrefix: "homeassistant",
    mqttTopicPrefix: "doorstate",
    mqttAllowUnlock: false,
    ...overrides,
  };
}

test("persists configuration with secrets redacted from the public view", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  const manager = new ConfigManager({ store: new ConfigStore(path), baseEnvironment: {} });
  await manager.load();
  await manager.save(form());

  const publicSettings = manager.publicSettings();
  assert.equal(publicSettings.apiTokenConfigured, true);
  assert.equal(publicSettings.adminPasswordConfigured, true);
  assert.equal("apiToken" in publicSettings, false);
  assert.deepEqual(publicSettings.doorIds, ["door-1"]);
  assert.equal(publicSettings.openLockDelayMs, 0);
  assert.equal(publicSettings.automationEnabled, false);
  assert.equal(publicSettings.nativeTriggerSeconds, 1);

  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.UNIFI_API_TOKEN, "api-token");
  assert.equal(stored.OPEN_LOCK_DELAY_MS, "0");
  assert.equal(stored.AUTOMATIC_DPS_RELOCK_ENABLED, "false");
  assert.equal(stored.NATIVE_TRIGGER_MS, "1000");
  assert.equal(stored.DRY_RUN, "true");
  assert.equal(stored.CLOSE_DEBOUNCE_MS, undefined);
  assert.match(stored.ADMIN_PASSWORD_HASH, /^scrypt\$/);
  assert.equal(stored.ADMIN_PASSWORD, undefined);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("automatic DPS relocking is opt-in and clears the legacy dry-run override", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  await manager.save(form({ automationEnabled: true, nativeTriggerSeconds: 1 }));

  assert.equal(manager.publicSettings().automationEnabled, true);
  assert.equal(manager.environment().AUTOMATIC_DPS_RELOCK_ENABLED, "true");
  assert.equal(manager.environment().DRY_RUN, "false");
  assert.equal(manager.tryConfig().config.doors.nativeTriggerMs, 1_000);
});

test("rejects a sub-second native trigger when automatic relocking is enabled", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  await assert.rejects(
    manager.save(form({ automationEnabled: true, nativeTriggerSeconds: 0.1 })),
    /must be at least 1000/,
  );
});

test("blank secret fields preserve existing values", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  await manager.save(form());
  await manager.save(form({ apiToken: "", adminPassword: "" }));
  assert.equal(manager.environment().UNIFI_API_TOKEN, "api-token");
  assert.match(manager.environment().ADMIN_PASSWORD_HASH, /^scrypt\$/);
});

test("changing an authenticated username also requires a new password", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  await manager.save(form());
  await assert.rejects(
    manager.save(form({ adminUsername: "operator", adminPassword: "", apiToken: "" })),
    /Enter a new administrator password/,
  );
});

test("persists manual MQTT settings while redacting the broker password", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  await manager.save(form({
    mqttEnabled: true,
    mqttBrokerUrl: "mqtt://192.0.2.30:1883",
    mqttUsername: "doorstate",
    mqttPassword: "test-mqtt-password",
    mqttAllowUnlock: true,
  }));

  const settings = manager.publicSettings();
  assert.equal(settings.mqttEnabled, true);
  assert.equal(settings.mqttPasswordConfigured, true);
  assert.equal(settings.mqttAllowUnlock, true);
  assert.equal("mqttPassword" in settings, false);
  assert.equal(manager.tryConfig().config.mqtt.url.href, "mqtt://192.0.2.30:1883");
  assert.equal(manager.environment().HA_MQTT_MANUAL_PASSWORD, "test-mqtt-password");
});

test("uses Supervisor MQTT credentials without copying them into persisted configuration", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  const manager = new ConfigManager({
    store: new ConfigStore(path),
    baseEnvironment: {
      HA_MQTT_URL: "mqtt://core-mosquitto:1883",
      HA_MQTT_USERNAME: "supervisor-user",
      HA_MQTT_PASSWORD: "supervisor-password",
      HA_MQTT_SOURCE: "supervisor",
    },
  });
  await manager.load();
  await manager.save(form({ mqttEnabled: true }));

  assert.equal(manager.publicSettings().mqttSource, "supervisor");
  assert.equal(manager.tryConfig().config.mqtt.username, "supervisor-user");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.HA_MQTT_USERNAME, undefined);
  assert.equal(stored.HA_MQTT_PASSWORD, undefined);
});

test("an unavailable MQTT broker does not prevent the UniFi controller configuration", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "unifi-access-lock-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const manager = new ConfigManager({
    store: new ConfigStore(join(directory, "config.json")),
    baseEnvironment: {},
  });
  await manager.load();
  const saved = await manager.save(form({ mqttEnabled: true, mqttBrokerUrl: "" }));
  assert.equal(saved.config.doors.lockTimeoutMs, 60_000);
  assert.equal(saved.config.mqtt.enabled, true);
  assert.match(saved.config.mqtt.error, /broker URL is required/);
});
