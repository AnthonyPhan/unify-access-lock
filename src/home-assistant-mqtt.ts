import { connect, type IClientOptions, type MqttClient } from "mqtt";

type Logger = {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};

type Door = {
  id: string;
  name?: string;
  fullName?: string;
  position?: string;
  relay?: string;
  hasDps?: boolean;
  lastEventAt?: number;
  lastEvent?: string;
};

type ArmedDoor = {
  doorId: string;
  locking?: boolean;
  unlockedAt?: number;
  relockAt?: number;
};

export type RuntimeSnapshot = {
  phase?: string;
  message?: string;
  doors?: Door[];
  armedDoors?: ArmedDoor[];
  automationEnabled?: boolean;
  emergencyActive?: boolean;
  lastWebhookAt?: number;
  lastWebhookEvent?: string;
};

type MqttSettings = {
  enabled: boolean;
  url?: URL;
  username?: string;
  password?: string;
  discoveryPrefix: string;
  topicPrefix: string;
  allowUnlock: boolean;
  source: string;
  error?: string;
};

type DoorSettings = {
  automationEnabled: boolean;
  lockTimeoutMs: number;
  openLockDelayMs: number;
};

export type DoorstateConfig = {
  mqtt: MqttSettings;
  doors: DoorSettings;
};

type OperationalChange = Partial<{
  automationEnabled: boolean;
  lockTimeoutSeconds: number;
  openLockDelayMs: number;
}>;

type BridgeOptions = {
  logger: Logger;
  getRuntimeSnapshot: () => RuntimeSnapshot;
  onDoorCommand: (doorId: string, command: "lock" | "unlock") => Promise<unknown>;
  onOperationalChange: (change: OperationalChange) => Promise<unknown>;
  onStatusChange?: () => void;
  connectClient?: typeof connect;
};

type DiscoveryEntity = {
  topic: string;
  payload: Record<string, unknown>;
};

type BridgePhase = "disabled" | "connecting" | "connected" | "offline" | "error";

const ORIGIN = {
  name: "Doorstate",
  sw_version: "0.2.0",
};

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "door";
}

function isoTime(value?: number): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function doorDevice(door: Door): Record<string, unknown> {
  return {
    identifiers: [`doorstate-door-${door.id}`],
    name: door.name || door.fullName || door.id,
    manufacturer: "Ubiquiti",
    model: "UniFi Access door",
    via_device: "doorstate-service",
  };
}

function serviceDevice(): Record<string, unknown> {
  return {
    identifiers: ["doorstate-service"],
    name: "Doorstate",
    manufacturer: "Doorstate",
    model: "UniFi Access relock controller",
    sw_version: ORIGIN.sw_version,
  };
}

function commonEntity(
  uniqueId: string,
  name: string | null,
  stateTopic: string,
  availabilityTopic: string,
  device: Record<string, unknown>,
): Record<string, unknown> {
  return {
    unique_id: uniqueId,
    name,
    state_topic: stateTopic,
    availability_topic: availabilityTopic,
    payload_available: "online",
    payload_not_available: "offline",
    device,
    origin: ORIGIN,
  };
}

export function buildDiscoveryEntities(
  snapshot: RuntimeSnapshot,
  config: DoorstateConfig,
): DiscoveryEntity[] {
  const { discoveryPrefix, topicPrefix, allowUnlock } = config.mqtt;
  const availabilityTopic = `${topicPrefix}/availability`;
  const serviceState = `${topicPrefix}/service/state`;
  const service = serviceDevice();
  const entities: DiscoveryEntity[] = [
    {
      topic: `${discoveryPrefix}/sensor/doorstate/runtime/config`,
      payload: {
        ...commonEntity("doorstate_runtime", "Runtime", serviceState, availabilityTopic, service),
        device_class: "enum",
        options: ["setup", "connecting", "ready", "error", "restart-required"],
        value_template: "{{ value_json.phase }}",
        entity_category: "diagnostic",
        icon: "mdi:access-point-check",
      },
    },
    {
      topic: `${discoveryPrefix}/binary_sensor/doorstate/api_connected/config`,
      payload: {
        ...commonEntity("doorstate_api_connected", "UniFi API", serviceState, availabilityTopic, service),
        device_class: "connectivity",
        value_template: "{{ 'ON' if value_json.api_connected else 'OFF' }}",
        entity_category: "diagnostic",
      },
    },
    {
      topic: `${discoveryPrefix}/sensor/doorstate/last_webhook/config`,
      payload: {
        ...commonEntity("doorstate_last_webhook", "Last webhook", serviceState, availabilityTopic, service),
        device_class: "timestamp",
        value_template: "{{ value_json.last_webhook_at }}",
        entity_category: "diagnostic",
        enabled_by_default: false,
      },
    },
    {
      topic: `${discoveryPrefix}/switch/doorstate/automatic_relocking/config`,
      payload: {
        ...commonEntity("doorstate_automatic_relocking", "Automatic relocking", serviceState, availabilityTopic, service),
        command_topic: `${topicPrefix}/service/automation/set`,
        value_template: "{{ 'ON' if value_json.automation_enabled else 'OFF' }}",
        payload_on: "ON",
        payload_off: "OFF",
        icon: "mdi:lock-clock",
      },
    },
    {
      topic: `${discoveryPrefix}/number/doorstate/maximum_unlock_time/config`,
      payload: {
        ...commonEntity("doorstate_maximum_unlock_time", "Maximum unlock time", serviceState, availabilityTopic, service),
        command_topic: `${topicPrefix}/service/maximum_unlock_time/set`,
        value_template: "{{ value_json.maximum_unlock_time }}",
        min: 1,
        max: 3600,
        step: 1,
        unit_of_measurement: "s",
        mode: "box",
        entity_category: "config",
        icon: "mdi:timer-lock-outline",
      },
    },
    {
      topic: `${discoveryPrefix}/number/doorstate/open_lock_delay/config`,
      payload: {
        ...commonEntity("doorstate_open_lock_delay", "Additional lock delay", serviceState, availabilityTopic, service),
        command_topic: `${topicPrefix}/service/open_lock_delay/set`,
        value_template: "{{ value_json.open_lock_delay }}",
        min: 0,
        max: 10000,
        step: 50,
        unit_of_measurement: "ms",
        mode: "box",
        entity_category: "config",
        icon: "mdi:timer-sand",
      },
    },
  ];

  for (const door of snapshot.doors ?? []) {
    const objectId = safeId(door.id);
    const stateTopic = `${topicPrefix}/doors/${objectId}/state`;
    const device = doorDevice(door);
    entities.push(
      {
        topic: `${discoveryPrefix}/binary_sensor/${objectId}/door/config`,
        payload: {
          ...commonEntity(`doorstate_${door.id}_door`, null, stateTopic, availabilityTopic, device),
          device_class: "door",
          value_template: "{{ value_json.position }}",
          payload_on: "open",
          payload_off: "close",
        },
      },
      {
        topic: `${discoveryPrefix}/sensor/${objectId}/relay/config`,
        payload: {
          ...commonEntity(`doorstate_${door.id}_relay`, "Lock relay", stateTopic, availabilityTopic, device),
          device_class: "enum",
          options: ["lock", "unlock", "unknown"],
          value_template: "{{ value_json.relay }}",
          entity_category: "diagnostic",
          icon: "mdi:electric-switch",
        },
      },
      {
        topic: `${discoveryPrefix}/sensor/${objectId}/automation/config`,
        payload: {
          ...commonEntity(`doorstate_${door.id}_automation`, "Relock state", stateTopic, availabilityTopic, device),
          device_class: "enum",
          options: ["disabled", "idle", "armed", "locking", "error", "emergency"],
          value_template: "{{ value_json.automation_state }}",
          icon: "mdi:lock-clock",
        },
      },
      {
        topic: `${discoveryPrefix}/sensor/${objectId}/last_event/config`,
        payload: {
          ...commonEntity(`doorstate_${door.id}_last_event`, "Last event", stateTopic, availabilityTopic, device),
          value_template: "{{ value_json.last_event }}",
          entity_category: "diagnostic",
          enabled_by_default: false,
          icon: "mdi:history",
        },
      },
      {
        topic: `${discoveryPrefix}/sensor/${objectId}/relock_at/config`,
        payload: {
          ...commonEntity(`doorstate_${door.id}_relock_at`, "Relocks at", stateTopic, availabilityTopic, device),
          device_class: "timestamp",
          value_template: "{{ value_json.relock_at or 'unknown' }}",
          icon: "mdi:timer-lock-outline",
        },
      },
      {
        topic: `${discoveryPrefix}/button/${objectId}/lock_now/config`,
        payload: {
          unique_id: `doorstate_${door.id}_lock_now`,
          name: "Lock now",
          command_topic: `${topicPrefix}/doors/${objectId}/lock_now/press`,
          payload_press: "PRESS",
          availability_topic: availabilityTopic,
          payload_available: "online",
          payload_not_available: "offline",
          device,
          origin: ORIGIN,
          icon: "mdi:lock",
        },
      },
    );

    if (allowUnlock) {
      entities.push({
        topic: `${discoveryPrefix}/button/${objectId}/unlock/config`,
        payload: {
          unique_id: `doorstate_${door.id}_unlock`,
          name: "Unlock",
          command_topic: `${topicPrefix}/doors/${objectId}/unlock/press`,
          payload_press: "PRESS",
          availability_topic: availabilityTopic,
          payload_available: "online",
          payload_not_available: "offline",
          device,
          origin: ORIGIN,
          icon: "mdi:gate-open",
        },
      });
    }
  }

  return entities;
}

export class HomeAssistantMqttBridge {
  private readonly logger: Logger;
  private readonly getRuntimeSnapshot: () => RuntimeSnapshot;
  private readonly onDoorCommand: BridgeOptions["onDoorCommand"];
  private readonly onOperationalChange: BridgeOptions["onOperationalChange"];
  private readonly onStatusChange?: () => void;
  private readonly connectClient: typeof connect;
  private client?: MqttClient;
  private config?: DoorstateConfig;
  private snapshotValue: RuntimeSnapshot = {};
  private discoveryTopics = new Set<string>();
  private phase: BridgePhase = "disabled";
  private error?: string;
  private commandQueue: Promise<void> = Promise.resolve();
  private recentCommands = new Map<string, number>();

  constructor(options: BridgeOptions) {
    this.logger = options.logger;
    this.getRuntimeSnapshot = options.getRuntimeSnapshot;
    this.onDoorCommand = options.onDoorCommand;
    this.onOperationalChange = options.onOperationalChange;
    this.onStatusChange = options.onStatusChange;
    this.connectClient = options.connectClient ?? connect;
  }

  status() {
    return {
      enabled: Boolean(this.config?.mqtt.enabled),
      phase: this.phase,
      source: this.config?.mqtt.source ?? "unconfigured",
      broker: this.config?.mqtt.url?.host,
      error: this.error,
    };
  }

  configure(config?: DoorstateConfig) {
    const previousConfig = this.config;
    const previousIdentity = this.connectionIdentity(previousConfig);
    const nextIdentity = this.connectionIdentity(config);
    this.snapshotValue = this.getRuntimeSnapshot();

    if (config?.mqtt.enabled && config.mqtt.error) {
      this.removeDiscovery();
      this.disconnect("error", previousConfig?.mqtt.topicPrefix);
      this.config = config;
      this.phase = "error";
      this.error = config.mqtt.error;
      this.logger.warn("Home Assistant MQTT configuration is invalid", { error: config.mqtt.error });
      this.onStatusChange?.();
      return;
    }

    if (!config?.mqtt.enabled || !config.mqtt.url) {
      this.removeDiscovery();
      this.disconnect("disabled", previousConfig?.mqtt.topicPrefix);
      this.config = config;
      this.onStatusChange?.();
      return;
    }

    if (this.client && previousIdentity === nextIdentity) {
      this.config = config;
      if (this.phase === "connected") this.publishAll();
      return;
    }

    this.removeDiscovery();
    this.disconnect("offline", previousConfig?.mqtt.topicPrefix);
    this.config = config;
    this.phase = "connecting";
    this.error = undefined;
    this.onStatusChange?.();

    const availabilityTopic = `${config.mqtt.topicPrefix}/availability`;
    const options: IClientOptions = {
      clientId: `doorstate_${Math.random().toString(16).slice(2)}`,
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      username: config.mqtt.username,
      password: config.mqtt.password,
      will: {
        topic: availabilityTopic,
        payload: Buffer.from("offline"),
        qos: 1,
        retain: true,
      },
    };
    const client = this.connectClient(config.mqtt.url.toString(), options);
    this.client = client;

    client.on("connect", () => {
      if (this.client !== client) return;
      this.phase = "connected";
      this.error = undefined;
      client.subscribe([
        `${config.mqtt.topicPrefix}/service/+/set`,
        `${config.mqtt.topicPrefix}/doors/+/+/+`,
      ], { qos: 1 }, (error) => {
        if (error) this.logger.error("Could not subscribe to Home Assistant MQTT commands", { error: error.message });
      });
      this.publish(availabilityTopic, "online", true, 1);
      this.publishAll();
      this.logger.info("Home Assistant MQTT bridge connected", {
        broker: config.mqtt.url?.host,
        source: config.mqtt.source,
      });
      this.onStatusChange?.();
    });

    client.on("message", (topic, payload) => {
      if (this.client !== client) return;
      const value = payload.toString("utf8");
      this.commandQueue = this.commandQueue.then(() => this.handleCommand(topic, value));
    });
    client.on("reconnect", () => {
      if (this.client !== client) return;
      this.phase = "connecting";
      this.onStatusChange?.();
    });
    client.on("close", () => {
      if (this.client !== client) return;
      this.phase = "offline";
      this.onStatusChange?.();
    });
    client.on("error", (error) => {
      if (this.client !== client) return;
      this.phase = "error";
      this.error = error.message;
      this.logger.warn("Home Assistant MQTT bridge error", { error: error.message });
      this.onStatusChange?.();
    });
  }

  update(snapshot: RuntimeSnapshot) {
    this.snapshotValue = snapshot;
    if (this.phase === "connected") this.publishAll();
  }

  private connectionIdentity(config?: DoorstateConfig): string {
    if (!config?.mqtt.enabled || !config.mqtt.url) return "disabled";
    return JSON.stringify({
      url: config.mqtt.url.toString(),
      username: config.mqtt.username,
      password: config.mqtt.password,
      discoveryPrefix: config.mqtt.discoveryPrefix,
      topicPrefix: config.mqtt.topicPrefix,
    });
  }

  private publishAll() {
    if (!this.config || this.phase !== "connected") return;
    this.publishDiscovery();
    this.publishStates();
  }

  private publishDiscovery() {
    if (!this.config) return;
    const entities = buildDiscoveryEntities(this.snapshotValue, this.config);
    const desired = new Set(entities.map((entity) => entity.topic));
    for (const staleTopic of this.discoveryTopics) {
      if (!desired.has(staleTopic)) this.publish(staleTopic, "", true, 1);
    }
    for (const entity of entities) {
      this.publish(entity.topic, JSON.stringify(entity.payload), true, 1);
    }
    for (const door of this.snapshotValue.doors ?? []) {
      this.publish(
        `${this.config.mqtt.discoveryPrefix}/lock/${safeId(door.id)}/lock/config`,
        "",
        true,
        1,
      );
    }
    this.discoveryTopics = desired;
  }

  private removeDiscovery() {
    for (const topic of this.discoveryTopics) this.publish(topic, "", true, 1);
    this.discoveryTopics.clear();
  }

  private publishStates() {
    if (!this.config) return;
    const { topicPrefix } = this.config.mqtt;
    const settings = this.config.doors;
    this.publish(`${topicPrefix}/service/state`, JSON.stringify({
      phase: this.snapshotValue.phase ?? "setup",
      api_connected: this.snapshotValue.phase === "ready",
      automation_enabled: Boolean(this.snapshotValue.automationEnabled),
      maximum_unlock_time: settings.lockTimeoutMs / 1_000,
      open_lock_delay: settings.openLockDelayMs,
      last_webhook_at: isoTime(this.snapshotValue.lastWebhookAt),
      last_webhook_event: this.snapshotValue.lastWebhookEvent ?? "unknown",
    }), true, 1);

    const armed = new Map((this.snapshotValue.armedDoors ?? []).map((door) => [door.doorId, door]));
    for (const door of this.snapshotValue.doors ?? []) {
      const armedDoor = armed.get(door.id);
      const automationState = this.snapshotValue.phase === "error"
        ? "error"
        : this.snapshotValue.emergencyActive
          ? "emergency"
          : !this.snapshotValue.automationEnabled
            ? "disabled"
            : armedDoor?.locking
              ? "locking"
              : armedDoor
                ? "armed"
                : "idle";
      this.publish(`${topicPrefix}/doors/${safeId(door.id)}/state`, JSON.stringify({
        position: door.position === "closed" ? "close" : door.position ?? "unknown",
        relay: door.relay ?? "unknown",
        automation_state: automationState,
        unlocked_at: isoTime(armedDoor?.unlockedAt),
        relock_at: isoTime(armedDoor?.relockAt),
        last_event: door.lastEvent ?? "unknown",
        last_event_at: isoTime(door.lastEventAt),
      }), true, 1);
    }
  }

  private async handleCommand(topic: string, rawPayload: string) {
    if (!this.config) return;
    const payload = rawPayload.trim();
    const signature = `${topic}\0${payload}`;
    const receivedAt = Date.now();
    if (receivedAt - (this.recentCommands.get(signature) ?? 0) < 1_000) return;
    this.recentCommands.set(signature, receivedAt);
    for (const [key, timestamp] of this.recentCommands) {
      if (receivedAt - timestamp > 60_000) this.recentCommands.delete(key);
    }
    const { topicPrefix } = this.config.mqtt;
    try {
      if (topic === `${topicPrefix}/service/automation/set`) {
        if (payload !== "ON" && payload !== "OFF") throw new Error("Automation command must be ON or OFF");
        await this.onOperationalChange({ automationEnabled: payload === "ON" });
        return;
      }
      if (topic === `${topicPrefix}/service/maximum_unlock_time/set`) {
        const value = Number(payload);
        if (!Number.isInteger(value) || value < 1 || value > 3600) throw new Error("Maximum unlock time must be 1-3600 seconds");
        await this.onOperationalChange({ lockTimeoutSeconds: value });
        return;
      }
      if (topic === `${topicPrefix}/service/open_lock_delay/set`) {
        const value = Number(payload);
        if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error("Open lock delay must be 0-10000 ms");
        await this.onOperationalChange({ openLockDelayMs: value });
        return;
      }

      const prefix = `${topicPrefix}/doors/`;
      if (!topic.startsWith(prefix)) return;
      const [objectId, control, action] = topic.slice(prefix.length).split("/");
      const door = (this.snapshotValue.doors ?? []).find((candidate) => safeId(candidate.id) === objectId);
      if (!door) throw new Error("MQTT command referenced an unknown door");

      if (control === "lock_now" && action === "press" && payload === "PRESS") {
        await this.onDoorCommand(door.id, "lock");
        return;
      }
      if (control === "unlock" && action === "press" && payload === "PRESS") {
        if (!this.config.mqtt.allowUnlock) throw new Error("MQTT unlock controls are disabled");
        await this.onDoorCommand(door.id, "unlock");
        return;
      }
      if (control === "lock" && action === "set") {
        if (payload === "LOCK") await this.onDoorCommand(door.id, "lock");
        else if (payload === "UNLOCK" && this.config.mqtt.allowUnlock) {
          await this.onDoorCommand(door.id, "unlock");
        } else throw new Error("MQTT unlock controls are disabled");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("Home Assistant MQTT command failed", { topic, error: message });
      this.error = message;
      this.onStatusChange?.();
    }
  }

  private publish(topic: string, payload: string, retain: boolean, qos: 0 | 1) {
    if (!this.client?.connected) return;
    this.client.publish(topic, payload, { retain, qos }, (error) => {
      if (error) this.logger.warn("Could not publish Home Assistant MQTT state", { topic, error: error.message });
    });
  }

  private disconnect(nextPhase: BridgePhase, topicPrefix = this.config?.mqtt.topicPrefix) {
    const client = this.client;
    this.client = undefined;
    if (client) {
      const availability = topicPrefix
        ? `${topicPrefix}/availability`
        : undefined;
      if (client.connected && availability) client.publish(availability, "offline", { retain: true, qos: 1 });
      client.end(true);
    }
    this.phase = nextPhase;
    this.error = undefined;
    this.onStatusChange?.();
  }

  stop() {
    this.removeDiscovery();
    this.disconnect("offline");
  }
}
