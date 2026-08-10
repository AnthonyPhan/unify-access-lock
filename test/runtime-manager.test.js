import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeManager, WEBHOOK_EVENTS } from "../src/runtime-manager.js";
import { UnifiApiError } from "../src/unifi-client.js";

const logger = { info() {}, warn() {}, error() {} };

test("connection diagnostics identify the endpoint and permission", () => {
  const runtime = new RuntimeManager({ logger });
  const source = new UnifiApiError("You do not have permission to perform this action", {
    method: "GET",
    path: "/api/v1/developer/doors",
    code: "CODE_UNAUTHORIZED",
    statusCode: 403,
  });

  const diagnostic = runtime.diagnosticError(source, {
    check: "Door discovery",
    permission: "Locations: View (view:space)",
  });

  assert.match(diagnostic.message, /Door discovery failed/);
  assert.match(diagnostic.message, /GET \/api\/v1\/developer\/doors/);
  assert.match(diagnostic.message, /CODE_UNAUTHORIZED/);
  assert.match(diagnostic.message, /view:space/);
});

test("webhook test verifies the subscription and records a signed delivery", async () => {
  let now = 1_700_000_000_000;
  const runtime = new RuntimeManager({
    logger,
    now: () => now,
    idGenerator: () => "test-id",
  });
  runtime.status = { phase: "ready", message: "Automation is active", doors: [] };
  runtime.webhookSecret = "secret";
  runtime.activeConfig = {
    webhook: {
      autoRegister: true,
      name: "unifi-access-lock",
      publicUrl: "http://192.0.2.20:8080/webhooks/unifi",
    },
  };
  runtime.client = {
    listWebhooks: async () => [{
      name: "unifi-access-lock",
      endpoint: "http://192.0.2.20:8080/webhooks/unifi",
      events: [...WEBHOOK_EVENTS],
    }],
  };

  const started = await runtime.startWebhookTest();
  assert.equal(started.status, "waiting");
  now += 2_000;
  runtime.recordWebhookDelivery({
    event: "access.door.unlock",
    data: { location: { id: "door-1", name: "Front door" } },
  });

  assert.deepEqual(runtime.webhookTest("test-id"), {
    id: "test-id",
    status: "received",
    startedAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    receivedAt: 1_700_000_002_000,
    event: "access.door.unlock",
    doorId: "door-1",
    doorName: "Front door",
  });
});

test("webhook test rejects a subscription pointing to the wrong URL", async () => {
  const runtime = new RuntimeManager({ logger });
  runtime.status = { phase: "ready", message: "Automation is active", doors: [] };
  runtime.webhookSecret = "secret";
  runtime.activeConfig = {
    webhook: {
      autoRegister: true,
      name: "unifi-access-lock",
      publicUrl: "http://192.0.2.20:8080/webhooks/unifi",
    },
  };
  runtime.client = {
    listWebhooks: async () => [{
      name: "unifi-access-lock",
      endpoint: "http://192.0.2.99:8080/webhooks/unifi",
      events: [...WEBHOOK_EVENTS],
    }],
  };

  await assert.rejects(runtime.startWebhookTest(), /UniFi is sending to/);
});

test("a DPS webhook updates the live door position and wakes status listeners", async () => {
  const now = 1_700_000_000_000;
  const runtime = new RuntimeManager({ logger, now: () => now });
  runtime.status = {
    phase: "ready",
    message: "Automation is active",
    doors: [{
      id: "door-1",
      name: "Front door",
      position: "close",
      hasDps: true,
    }],
  };

  const initial = runtime.snapshot();
  const changed = runtime.waitForStatusChange(initial.revision);
  runtime.recordWebhookDelivery({
    event: "access.device.dps_status",
    data: {
      device: { location_id: "door-1" },
      object: { status: "open" },
    },
  });

  const snapshot = await changed;
  assert.equal(snapshot.revision, initial.revision + 1);
  assert.deepEqual(snapshot.doors[0], {
    id: "door-1",
    name: "Front door",
    position: "open",
    hasDps: true,
    lastDpsAt: now,
  });
});

test("the direct lock test reports lock_early acceptance and the rule transition", async () => {
  const calls = [];
  const rules = [{ type: "reset" }, { type: "lock_now" }];
  const doors = [
    { door_lock_relay_status: "unlock", door_position_status: "close" },
    { door_lock_relay_status: "lock", door_position_status: "close" },
  ];
  const runtime = new RuntimeManager({ logger, sleep: async () => {} });
  runtime.status = {
    phase: "ready",
    message: "Automation is active",
    emergencyActive: false,
    doors: [{ id: "door-1", name: "Front door" }],
  };
  runtime.client = {
    getLockRule: async () => rules.shift(),
    getDoor: async () => doors.shift(),
    lockEarly: async (doorId) => calls.push(doorId),
  };

  assert.deepEqual(await runtime.testDoorCommand("door-1", "lock_early"), {
    accepted: true,
    command: "lock_early",
    doorId: "door-1",
    doorName: "Front door",
    beforeRelay: "unlock",
    afterRelay: "lock",
    afterPosition: "close",
    beforeRule: "reset",
    afterRule: "lock_now",
    afterReadError: undefined,
  });
  assert.deepEqual(calls, ["door-1"]);
});

test("the direct door test can issue the official remote unlock command", async () => {
  const calls = [];
  const runtime = new RuntimeManager({ logger, sleep: async () => {} });
  runtime.status = {
    phase: "ready",
    message: "Automation is active",
    emergencyActive: false,
    doors: [{ id: "door-1", name: "Front door" }],
  };
  runtime.client = {
    getLockRule: async () => ({ type: "reset" }),
    getDoor: async () => ({
      door_lock_relay_status: calls.length ? "unlock" : "lock",
      door_position_status: "close",
    }),
    unlockDoor: async (doorId) => calls.push(doorId),
  };

  const result = await runtime.testDoorCommand("door-1", "unlock");
  assert.equal(result.accepted, true);
  assert.equal(result.command, "unlock");
  assert.equal(result.beforeRelay, "lock");
  assert.equal(result.afterRelay, "unlock");
  assert.deepEqual(calls, ["door-1"]);
});

test("the direct door test can reset a temporary unlock rule", async () => {
  const calls = [];
  const rules = [{ type: "custom" }, { type: "reset" }];
  const doors = [
    { door_lock_relay_status: "unlock", door_position_status: "close" },
    { door_lock_relay_status: "lock", door_position_status: "close" },
  ];
  const runtime = new RuntimeManager({ logger, sleep: async () => {} });
  runtime.status = {
    phase: "ready",
    message: "Automation is active",
    emergencyActive: false,
    doors: [{ id: "door-1", name: "Front door" }],
  };
  runtime.client = {
    getLockRule: async () => rules.shift(),
    getDoor: async () => doors.shift(),
    resetLockRule: async (doorId) => calls.push(doorId),
  };

  const result = await runtime.testDoorCommand("door-1", "reset");
  assert.equal(result.accepted, true);
  assert.equal(result.command, "reset");
  assert.equal(result.beforeRelay, "unlock");
  assert.equal(result.afterRelay, "lock");
  assert.equal(result.beforeRule, "custom");
  assert.equal(result.afterRule, "reset");
  assert.deepEqual(calls, ["door-1"]);
});

test("the direct door test can start a one-minute custom unlock rule", async () => {
  const calls = [];
  const rules = [{ type: "reset" }, { type: "custom" }];
  const doors = [
    { door_lock_relay_status: "lock", door_position_status: "close" },
    { door_lock_relay_status: "unlock", door_position_status: "close" },
  ];
  const runtime = new RuntimeManager({ logger, sleep: async () => {} });
  runtime.status = {
    phase: "ready",
    message: "Automation is active",
    emergencyActive: false,
    doors: [{ id: "door-1", name: "Front door" }],
  };
  runtime.client = {
    getLockRule: async () => rules.shift(),
    getDoor: async () => doors.shift(),
    customUnlock: async (doorId, interval) => calls.push({ doorId, interval }),
  };

  const result = await runtime.testDoorCommand("door-1", "custom");
  assert.equal(result.accepted, true);
  assert.equal(result.command, "custom");
  assert.equal(result.beforeRelay, "lock");
  assert.equal(result.afterRelay, "unlock");
  assert.equal(result.afterRule, "custom");
  assert.deepEqual(calls, [{ doorId: "door-1", interval: 1 }]);
});

test("the one-second handoff test waits out the native trigger before sending lock_now", async () => {
  const calls = [];
  const sleeps = [];
  const rules = [
    { type: "reset" },
    { type: "custom" },
    { type: "reset" },
  ];
  const doors = [
    { door_lock_relay_status: "lock", door_position_status: "close" },
    { door_lock_relay_status: "unlock", door_position_status: "close" },
    { door_lock_relay_status: "lock", door_position_status: "close" },
  ];
  const runtime = new RuntimeManager({
    logger,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  runtime.status = {
    phase: "ready",
    message: "Connected in monitor-only mode",
    emergencyActive: false,
    doors: [{ id: "door-1", name: "Front door" }],
  };
  runtime.client = {
    getLockRule: async () => rules.shift(),
    getDoor: async () => doors.shift(),
    unlockDoor: async (doorId) => calls.push(["unlock", doorId]),
    customUnlock: async (doorId, interval) => calls.push(["custom", doorId, interval]),
    lockNow: async (doorId) => calls.push(["lock_now", doorId]),
  };

  const result = await runtime.testDoorCommand("door-1", "handoff_1s");
  assert.equal(result.beforeRelay, "lock");
  assert.equal(result.handoffRelay, "unlock");
  assert.equal(result.handoffRule, "custom");
  assert.equal(result.afterRelay, "lock");
  assert.equal(result.afterRule, "reset");
  assert.deepEqual(calls, [
    ["unlock", "door-1"],
    ["custom", "door-1", 1],
    ["lock_now", "door-1"],
  ]);
  assert.deepEqual(sleeps, [250, 1_750, 200]);
});
