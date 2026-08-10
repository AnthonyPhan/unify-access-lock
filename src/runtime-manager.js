import { randomUUID } from "node:crypto";
import { DoorController } from "./door-controller.js";
import { UnifiAccessClient } from "./unifi-client.js";

export const WEBHOOK_EVENTS = [
  "access.door.unlock",
  "access.device.dps_status",
  "access.unlock_schedule.activate",
  "access.unlock_schedule.deactivate",
  "access.temporary_unlock.start",
  "access.temporary_unlock.end",
  "access.device.emergency_status",
];

export class RuntimeManager {
  constructor({
    logger,
    now = Date.now,
    webhookTestTtlMs = 60_000,
    idGenerator = randomUUID,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }) {
    this.logger = logger;
    this.now = now;
    this.webhookTestTtlMs = webhookTestTtlMs;
    this.idGenerator = idGenerator;
    this.sleep = sleep;
    this.generation = 0;
    this.controller = undefined;
    this.client = undefined;
    this.activeConfig = undefined;
    this.webhookSecret = undefined;
    this.webhookPath = "/webhooks/unifi";
    this.webhookTests = new Map();
    this.statusRevision = 0;
    this.statusWaiters = new Set();
    this.status = {
      phase: "setup",
      message: "Configuration is required",
      doors: [],
      monitoredDoorIds: [],
    };
  }

  async test(config) {
    const client = new UnifiAccessClient(config.unifi);
    let doors;
    try {
      doors = await client.listDoors();
    } catch (error) {
      throw this.diagnosticError(error, {
        check: "Door discovery",
        permission: "Locations: View (view:space)",
      });
    }

    let emergencyStatus;
    try {
      emergencyStatus = await client.getEmergencyStatus();
    } catch (error) {
      throw this.diagnosticError(error, {
        check: "Emergency-status check",
        permission: "Locations: View (view:space)",
      });
    }

    return {
      doors: (doors ?? []).map((door) => ({
        id: door.id,
        name: door.name,
        fullName: door.full_name,
        position: door.door_position_status,
        hasDps: door.door_position_status != null,
      })),
      emergencyStatus,
    };
  }

  diagnosticError(error, { check, permission }) {
    const endpoint = error.path ? ` ${error.method || "GET"} ${error.path}` : "";
    const code = error.code ? ` [${error.code}]` : "";
    return new Error(`${check} failed on${endpoint}${code}: ${error.message}. Required permission: ${permission}.`);
  }

  async configure(config) {
    const generation = ++this.generation;
    this.stopController();
    this.webhookSecret = undefined;
    this.webhookPath = config.server.webhookPath;
    this.status = { ...this.status, phase: "connecting", message: "Connecting to UniFi Access" };
    this.publishStatus();

    try {
      const client = new UnifiAccessClient(config.unifi);
      const [doors, emergencyStatus] = await Promise.all([
        client.listDoors(),
        client.getEmergencyStatus(),
      ]);
      if (generation !== this.generation) return;

      const knownIds = new Set((doors ?? []).map((door) => door.id));
      for (const doorId of config.doors.ids) {
        if (!knownIds.has(doorId)) throw new Error(`Selected door no longer exists: ${doorId}`);
      }

      let webhookSecret = config.webhook.secret;
      if (config.webhook.autoRegister) {
        const webhook = await client.ensureWebhook({
          name: config.webhook.name,
          endpoint: config.webhook.publicUrl,
          events: WEBHOOK_EVENTS,
        });
        webhookSecret = webhook.secret;
      }
      if (generation !== this.generation) return;

      const controller = new DoorController({
        client,
        monitoredDoorIds: config.doors.ids,
        lockTimeoutMs: config.doors.lockTimeoutMs,
        nativeTriggerMs: config.doors.nativeTriggerMs,
        openLockDelayMs: config.doors.openLockDelayMs,
        dryRun: config.doors.dryRun,
        automationEnabled: config.doors.automationEnabled,
        emergencyActive: Boolean(emergencyStatus?.evacuation || emergencyStatus?.lockdown),
        logger: this.logger,
        now: this.now,
      });

      this.controller = controller;
      this.client = client;
      this.activeConfig = config;
      this.webhookSecret = webhookSecret;
      const publicDoors = (doors ?? []).map((door) => ({
        id: door.id,
        name: door.name,
        fullName: door.full_name,
        position: door.door_position_status,
        hasDps: door.door_position_status != null,
        lastDpsAt: undefined,
      }));
      this.status = {
        phase: "ready",
        message: config.doors.automationEnabled
          ? "Automatic DPS relocking is active"
          : "Connected in monitor-only mode; automatic DPS relocking is disabled",
        doors: publicDoors,
        monitoredDoorIds: [...config.doors.ids],
        dryRun: config.doors.dryRun,
        automationEnabled: config.doors.automationEnabled,
        nativeTriggerMs: config.doors.nativeTriggerMs,
        emergencyActive: Boolean(emergencyStatus?.evacuation || emergencyStatus?.lockdown),
      };
      this.publishStatus();
      this.logger.info("UniFi Access lock service is configured", {
        monitoredDoors: config.doors.ids.size || "all",
        automationEnabled: config.doors.automationEnabled,
        nativeTriggerMs: config.doors.nativeTriggerMs,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.status = {
        ...this.status,
        phase: "error",
        message: error.message,
        doors: [],
      };
      this.publishStatus();
      this.logger.error("Could not activate UniFi automation", { error: error.message });
    }
  }

  markRestartRequired(message) {
    this.status = { ...this.status, phase: "restart-required", message };
    this.publishStatus();
  }

  async testDoorCommand(doorId, command) {
    if (this.status.phase !== "ready" || !this.client) {
      throw new Error("Save and apply a working configuration before testing a door command");
    }
    if (this.status.emergencyActive) {
      throw new Error("The lock command test is disabled while a UniFi emergency mode is active");
    }

    const door = (this.status.doors ?? []).find((candidate) => candidate.id === doorId);
    if (!door) throw new Error("Select a door currently connected to this service");
    if (!["unlock", "custom", "reset", "lock_early", "lock_now", "handoff_1s"].includes(command)) {
      throw new Error("Unsupported door command");
    }

    let beforeRule;
    let beforeDoor;
    try {
      [beforeRule, beforeDoor] = await Promise.all([
        this.client.getLockRule(doorId),
        this.client.getDoor(doorId),
      ]);
    } catch (error) {
      throw this.diagnosticError(error, {
        check: "Pre-command door-state check",
        permission: "Locations: View (view:space)",
      });
    }

    let handoffRule;
    let handoffDoor;
    let handoffReadError;
    try {
      if (command === "handoff_1s") {
        await this.client.unlockDoor(doorId);
        await this.sleep(250);
        await this.client.customUnlock(doorId, 1);
        // The original one-second native trigger has now expired, while the
        // custom one-minute rule should still be holding the relay unlocked.
        await this.sleep(1_750);
        try {
          [handoffRule, handoffDoor] = await Promise.all([
            this.client.getLockRule(doorId),
            this.client.getDoor(doorId),
          ]);
        } catch (error) {
          handoffReadError = error.message;
        }
        await this.client.lockNow(doorId);
      } else if (command === "unlock") await this.client.unlockDoor(doorId);
      else if (command === "custom") await this.client.customUnlock(doorId, 1);
      else if (command === "reset") await this.client.resetLockRule(doorId);
      else if (command === "lock_early") await this.client.lockEarly(doorId);
      else await this.client.lockNow(doorId);
    } catch (error) {
      throw this.diagnosticError(error, {
        check: `${command} command`,
        permission: "Locations: Edit (edit:space)",
      });
    }

    await this.sleep(200);
    let afterRule;
    let afterDoor;
    let afterReadError;
    try {
      [afterRule, afterDoor] = await Promise.all([
        this.client.getLockRule(doorId),
        this.client.getDoor(doorId),
      ]);
    } catch (error) {
      afterReadError = error.message;
    }

    const ruleType = (rule) => {
      const value = Array.isArray(rule)
        ? rule[0]?.type
        : rule?.type ?? rule?.lock_rule?.type ?? rule?.rule?.type ?? rule?.lock_rule_type;
      return typeof value === "string" && value.trim() ? value.trim() : "unknown";
    };
    const doorValue = (value) => (Array.isArray(value) ? value[0] : value);
    const relayStatus = (value) => doorValue(value)?.door_lock_relay_status || "unknown";
    const positionStatus = (value) => doorValue(value)?.door_position_status || "unknown";
    this.logger.info("Manual door API test accepted by UniFi", {
      doorId,
      door: door.name,
      command,
      beforeRelay: relayStatus(beforeDoor),
      afterRelay: relayStatus(afterDoor),
      beforeRule: ruleType(beforeRule),
      afterRule: ruleType(afterRule),
    });
    return {
      accepted: true,
      command,
      doorId,
      doorName: door.name || door.fullName || door.id,
      beforeRelay: relayStatus(beforeDoor),
      afterRelay: relayStatus(afterDoor),
      afterPosition: positionStatus(afterDoor),
      beforeRule: ruleType(beforeRule),
      afterRule: ruleType(afterRule),
      ...(command === "handoff_1s"
        ? {
            handoffRelay: handoffDoor === undefined ? "unknown" : relayStatus(handoffDoor),
            handoffRule: handoffRule === undefined ? "unknown" : ruleType(handoffRule),
            handoffReadError,
          }
        : {}),
      afterReadError,
    };
  }

  async startWebhookTest() {
    if (this.status.phase !== "ready" || !this.client || !this.activeConfig || !this.webhookSecret) {
      throw new Error("Save and apply a working configuration before testing webhook delivery");
    }

    const config = this.activeConfig;
    if (config.webhook.autoRegister) {
      let endpoints;
      try {
        endpoints = (await this.client.listWebhooks()) ?? [];
      } catch (error) {
        throw this.diagnosticError(error, {
          check: "Webhook subscription lookup",
          permission: "Webhooks: View (view:webhook)",
        });
      }

      const endpoint = endpoints.find((candidate) => candidate.name === config.webhook.name);
      if (!endpoint) {
        throw new Error(`UniFi has no webhook subscription named ${config.webhook.name}`);
      }
      if (endpoint.endpoint !== config.webhook.publicUrl) {
        throw new Error(
          `UniFi is sending to ${endpoint.endpoint}, but Doorstate is configured for ${config.webhook.publicUrl}`,
        );
      }
      const missingEvents = WEBHOOK_EVENTS.filter((event) => !endpoint.events?.includes(event));
      if (missingEvents.length) {
        throw new Error(`The UniFi webhook subscription is missing: ${missingEvents.join(", ")}`);
      }
    }

    this.pruneWebhookTests();
    const startedAt = this.now();
    const test = {
      id: this.idGenerator(),
      status: "waiting",
      startedAt,
      expiresAt: startedAt + this.webhookTestTtlMs,
    };
    this.webhookTests.set(test.id, test);
    return { ...test };
  }

  webhookTest(testId) {
    this.pruneWebhookTests();
    const test = this.webhookTests.get(testId);
    if (!test) throw new Error("Webhook test was not found or has expired");
    if (test.status === "waiting" && this.now() >= test.expiresAt) test.status = "expired";
    return { ...test };
  }

  recordWebhookDelivery(event) {
    const receivedAt = this.now();
    for (const test of this.webhookTests.values()) {
      if (test.status !== "waiting" || receivedAt >= test.expiresAt) continue;
      test.status = "received";
      test.receivedAt = receivedAt;
      test.event = event.event;
      test.doorId = event?.data?.location?.id ?? event?.data?.device?.location_id;
      test.doorName = event?.data?.location?.name ?? event?.data?.device?.alias;
    }

    if (event?.event !== "access.device.dps_status") return;
    const position = event?.data?.object?.status;
    if (position !== "open" && position !== "close") return;

    const doorId = event?.data?.location?.id ?? event?.data?.device?.location_id;
    let found = false;
    const doors = (this.status.doors ?? []).map((door) => {
      if (door.id !== doorId) return door;
      found = true;
      return {
        ...door,
        position,
        hasDps: true,
        lastDpsAt: receivedAt,
      };
    });

    if (found) {
      this.status = { ...this.status, doors };
      this.publishStatus();
    }
  }

  pruneWebhookTests() {
    const cutoff = this.now() - 5 * 60_000;
    for (const [id, test] of this.webhookTests) {
      if (test.expiresAt < cutoff) this.webhookTests.delete(id);
    }
  }

  webhookContext(pathname) {
    if (pathname !== this.webhookPath) return undefined;
    if (!this.controller || !this.webhookSecret) return { ready: false };
    return { ready: true, controller: this.controller, secret: this.webhookSecret };
  }

  snapshot() {
    return {
      ...this.status,
      revision: this.statusRevision,
      armedDoors: this.controller?.snapshot() ?? [],
    };
  }

  waitForStatusChange(revision, timeoutMs = 25_000) {
    if (revision !== this.statusRevision) return Promise.resolve(this.snapshot());

    return new Promise((resolve) => {
      const waiter = {
        resolve: () => {
          clearTimeout(waiter.timer);
          this.statusWaiters.delete(waiter);
          resolve(this.snapshot());
        },
        timer: undefined,
      };
      waiter.timer = setTimeout(waiter.resolve, timeoutMs);
      waiter.timer.unref?.();
      this.statusWaiters.add(waiter);
    });
  }

  publishStatus() {
    this.statusRevision += 1;
    for (const waiter of [...this.statusWaiters]) waiter.resolve();
  }

  stopController() {
    this.controller?.stop?.();
    this.controller = undefined;
    this.client = undefined;
    this.activeConfig = undefined;
    this.webhookTests.clear();
  }

  stop() {
    this.generation += 1;
    this.stopController();
    this.publishStatus();
  }
}
