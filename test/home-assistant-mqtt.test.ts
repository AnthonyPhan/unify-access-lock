import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connect, type IClientOptions } from "mqtt";
import {
  buildDiscoveryEntities,
  HomeAssistantMqttBridge,
  type DoorstateConfig,
} from "../src/home-assistant-mqtt.ts";

function config(allowUnlock = false): DoorstateConfig {
  return {
    mqtt: {
      enabled: true,
      url: new URL("mqtt://broker:1883"),
      discoveryPrefix: "homeassistant",
      topicPrefix: "doorstate",
      allowUnlock,
      source: "supervisor",
    },
    doors: {
      automationEnabled: true,
      lockTimeoutMs: 60_000,
      openLockDelayMs: 250,
    },
  };
}

const snapshot = {
  phase: "ready",
  automationEnabled: true,
  doors: [{
    id: "door-1",
    name: "Front gate",
    position: "close",
    relay: "lock",
    hasDps: true,
  }],
  armedDoors: [],
};

test("publishes native Home Assistant service and door entities", () => {
  const entities = buildDiscoveryEntities(snapshot, config());
  const topics = entities.map((entity) => entity.topic);

  assert.ok(topics.includes("homeassistant/binary_sensor/door-1/door/config"));
  assert.ok(topics.includes("homeassistant/button/door-1/lock_now/config"));
  assert.ok(topics.includes("homeassistant/sensor/door-1/relock_at/config"));
  assert.ok(topics.includes("homeassistant/switch/doorstate/automatic_relocking/config"));
  assert.ok(topics.includes("homeassistant/number/doorstate/maximum_unlock_time/config"));
  assert.equal(topics.some((topic) => topic.startsWith("homeassistant/lock/")), false);

  const door = entities.find((entity) => entity.topic.endsWith("/door/config"));
  assert.deepEqual(door?.payload.device, {
    identifiers: ["doorstate-door-door-1"],
    name: "Front gate",
    manufacturer: "Ubiquiti",
    model: "UniFi Access door",
    via_device: "doorstate-service",
  });
});

test("only publishes the native lock slider after explicit remote-unlock opt-in", () => {
  const entities = buildDiscoveryEntities(snapshot, config(true));
  const lock = entities.find((entity) => entity.topic === "homeassistant/lock/door-1/lock/config");
  assert.ok(lock);
  assert.equal(lock.payload.command_topic, "doorstate/doors/door-1/lock/set");
  assert.equal(lock.payload.json_attributes_topic, "doorstate/doors/door-1/state");
  assert.equal(lock.payload.payload_lock, "LOCK");
  assert.equal(lock.payload.payload_unlock, "UNLOCK");
  assert.equal(entities.some((entity) => entity.topic.includes("/button/door-1/unlock/")), false);
});

test("does not place broker credentials in discovery payloads", () => {
  const withCredentials = config(true);
  withCredentials.mqtt.username = "mqtt-user";
  withCredentials.mqtt.password = "mqtt-password";
  const serialized = JSON.stringify(buildDiscoveryEntities(snapshot, withCredentials));
  assert.equal(serialized.includes("mqtt-user"), false);
  assert.equal(serialized.includes("mqtt-password"), false);
});

class FakeMqttClient extends EventEmitter {
  connected = true;
  publications: Array<{ topic: string; payload: string; retain: boolean }> = [];
  subscriptions: string[] = [];

  publish(topic: string, payload: string | Buffer, options: { retain?: boolean }, callback?: (error?: Error) => void) {
    this.publications.push({ topic, payload: payload.toString(), retain: Boolean(options.retain) });
    callback?.();
    return this;
  }

  subscribe(topics: string | string[], _options: unknown, callback?: (error?: Error) => void) {
    this.subscriptions.push(...(Array.isArray(topics) ? topics : [topics]));
    callback?.();
    return this;
  }

  end() {
    this.connected = false;
    return this;
  }
}

test("connects, publishes discovery and serializes Home Assistant commands", async () => {
  const client = new FakeMqttClient();
  const changes: unknown[] = [];
  const doorCommands: unknown[] = [];
  const bridge = new HomeAssistantMqttBridge({
    logger: { info() {}, warn() {}, error() {} },
    getRuntimeSnapshot: () => snapshot,
    onOperationalChange: async (change) => { changes.push(change); },
    onDoorCommand: async (doorId, command) => { doorCommands.push({ doorId, command }); },
    connectClient: ((_url: string, _options: IClientOptions) => client) as unknown as typeof connect,
  });

  bridge.configure(config(true));
  client.emit("connect");
  assert.deepEqual(client.subscriptions, [
    "doorstate/service/+/set",
    "doorstate/doors/+/+/+",
  ]);
  assert.ok(client.publications.some((item) => item.topic === "homeassistant/lock/door-1/lock/config" && item.payload !== ""));
  assert.ok(client.publications.some((item) => (
    item.topic === "homeassistant/button/door-1/unlock/config" && item.payload === ""
  )));
  const doorState = client.publications.find((item) => item.topic === "doorstate/doors/door-1/state");
  assert.ok(doorState);
  assert.equal(JSON.parse(doorState.payload).relock_at, null);

  client.emit("message", "doorstate/service/automation/set", Buffer.from("OFF"));
  client.emit("message", "doorstate/doors/door-1/lock/set", Buffer.from("UNLOCK"));
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(changes, [{ automationEnabled: false }]);
  assert.deepEqual(doorCommands, [{ doorId: "door-1", command: "unlock" }]);
});

test("publishes the controller's active relock deadline as a timestamp", () => {
  const client = new FakeMqttClient();
  const relockAt = Date.parse("2026-08-19T12:01:00.000Z");
  const armedSnapshot = {
    ...snapshot,
    doors: snapshot.doors.map((door) => ({ ...door, relay: "unlock" })),
    armedDoors: [{ doorId: "door-1", unlockedAt: relockAt - 60_000, relockAt }],
  };
  const bridge = new HomeAssistantMqttBridge({
    logger: { info() {}, warn() {}, error() {} },
    getRuntimeSnapshot: () => armedSnapshot,
    onOperationalChange: async () => {},
    onDoorCommand: async () => {},
    connectClient: ((_url: string, _options: IClientOptions) => client) as unknown as typeof connect,
  });

  bridge.configure(config(true));
  client.emit("connect");

  const doorState = client.publications.find((item) => item.topic === "doorstate/doors/door-1/state");
  assert.ok(doorState);
  assert.equal(JSON.parse(doorState.payload).relock_at, "2026-08-19T12:01:00.000Z");
  assert.equal(JSON.parse(doorState.payload).maximum_unlock_time, 60);
});
