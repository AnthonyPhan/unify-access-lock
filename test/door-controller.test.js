import assert from "node:assert/strict";
import test from "node:test";
import { DoorController } from "../src/door-controller.js";

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }

  set = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  clear = (id) => this.timers.delete(id);

  runByDelay(delay) {
    for (const [id, timer] of [...this.timers]) {
      if (timer.delay === delay) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function event(name, status) {
  return {
    event: name,
    event_object_id: `${name}-${status ?? "event"}`,
    data: {
      location: { id: "door-1", name: "Front door" },
      object: status ? { status } : {},
    },
  };
}

function setup({
  lockRule,
  doorPosition = "close",
  openLockDelayMs = 0,
  nativeTriggerMs = 0,
  nativeTriggerSafetyMs = 0,
  automationEnabled = true,
  now = () => 0,
  relayStatuses,
} = {}) {
  const calls = [];
  const customCalls = [];
  const timers = new FakeTimers();
  const client = {
    getLockRule: async () => lockRule ?? { type: "reset" },
    getDoor: async () => {
      const relayStatus = relayStatuses?.shift();
      return {
        door_position_status: doorPosition,
        ...(relayStatus === undefined ? {} : { door_lock_relay_status: relayStatus }),
      };
    },
    getEmergencyStatus: async () => ({ evacuation: false, lockdown: false }),
    customUnlock: async (doorId, interval) => customCalls.push({ doorId, interval }),
    lockNow: async (doorId) => calls.push(doorId),
  };
  const logger = { info() {}, warn() {}, error() {} };
  const controller = new DoorController({
    client,
    logger,
    setTimer: timers.set,
    clearTimer: timers.clear,
    sleep: async () => {},
    lockTimeoutMs: 60_000,
    nativeTriggerMs,
    nativeTriggerSafetyMs,
    openLockDelayMs,
    automationEnabled,
    now,
  });
  return { calls, customCalls, controller, timers };
}

test("monitor-only mode discards unlock and DPS events without arming or calling the API", async () => {
  const { calls, controller, timers } = setup({ automationEnabled: false });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  timers.runByDelay(60_000);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.snapshot(), []);
});

test("locks as soon as the door opens", async () => {
  const { calls, customCalls, controller, timers } = setup();
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
  assert.deepEqual(customCalls, [{ doorId: "door-1", interval: 1 }]);
  assert.deepEqual(controller.snapshot(), []);
});

test("waits for the native trigger safety window before locking an open door", async () => {
  const { calls, controller, timers } = setup({
    nativeTriggerMs: 1_000,
    nativeTriggerSafetyMs: 250,
  });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  timers.runByDelay(1_250);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
});

test("retries when UniFi accepts lock_now but reports the relay still unlocked", async () => {
  const { calls, controller, timers } = setup({
    relayStatuses: [undefined, "unlock", "lock"],
  });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1", "door-1"]);
  assert.deepEqual(controller.snapshot(), []);
});

test("honors the configured open-to-lock delay", async () => {
  const { calls, controller, timers } = setup({ openLockDelayMs: 250 });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  timers.runByDelay(250);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
});

test("reports the current relock deadline and shortens it after a fresh open", async () => {
  let currentTime = 1_000;
  const { controller } = setup({
    openLockDelayMs: 250,
    nativeTriggerMs: 1_000,
    nativeTriggerSafetyMs: 250,
    now: () => currentTime,
  });

  await controller.handle(event("access.door.unlock"));
  assert.equal(controller.snapshot()[0].unlockedAt, 1_000);
  assert.equal(controller.snapshot()[0].relockAt, 61_000);

  currentTime = 1_100;
  await controller.handle(event("access.device.dps_status", "open"));
  assert.equal(controller.snapshot()[0].relockAt, 2_500);
});

test("does not lock on a close event before the door opens", async () => {
  const { calls, controller, timers } = setup();
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "close"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.equal(controller.snapshot().length, 1);
});

test("locks when the maximum timeout expires", async () => {
  const { calls, controller, timers } = setup();
  await controller.handle(event("access.door.unlock"));
  timers.runByDelay(60_000);
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
});

test("an already-open snapshot does not immediately collapse a new unlock", async () => {
  const { calls, controller, timers } = setup({ doorPosition: "open" });
  await controller.handle(event("access.door.unlock"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.equal(controller.snapshot()[0].sawOpen, false);
});

test("an already-open snapshot requires a close-to-open transition before relocking", async () => {
  const { calls, controller, timers } = setup({ doorPosition: "open" });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);

  await controller.handle(event("access.device.dps_status", "close"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
});

test("a Tap to unlock temporary event does not disarm an ordinary remote unlock", async () => {
  const { calls, controller, timers } = setup();
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.temporary_unlock.start"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  await new Promise(setImmediate);
  assert.deepEqual(calls, ["door-1"]);
});

test("does not interfere with an active unlock schedule", async () => {
  const { calls, controller, timers } = setup({ lockRule: { type: "schedule" } });
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  timers.runByDelay(0);
  timers.runByDelay(60_000);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.snapshot(), []);
});

test("does not recursively take over an existing custom unlock rule", async () => {
  const { calls, customCalls, controller, timers } = setup({ lockRule: [{ type: "custom" }] });
  await controller.handle(event("access.door.unlock"));
  timers.runByDelay(60_000);
  await new Promise(setImmediate);
  assert.deepEqual(customCalls, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.snapshot(), []);
});

test("filters events to configured door IDs", async () => {
  const { calls, controller, timers } = setup();
  controller.monitoredDoorIds = new Set(["another-door"]);
  await controller.handle(event("access.door.unlock"));
  timers.runByDelay(60_000);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
});

test("disarms pending actions when emergency mode activates", async () => {
  const { calls, controller, timers } = setup();
  await controller.handle(event("access.door.unlock"));
  await controller.handle(event("access.device.dps_status", "open"));
  await controller.handle({
    event: "access.device.emergency_status",
    data: { object: { mode: "evacuation", value: true } },
  });
  timers.runByDelay(0);
  timers.runByDelay(60_000);
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.deepEqual(controller.snapshot(), []);
});
