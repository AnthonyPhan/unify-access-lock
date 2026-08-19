const PROTECTED_LOCK_RULES = new Set(["schedule", "keep_unlock", "custom"]);
const SUSPEND_EVENTS = new Set(["access.unlock_schedule.activate"]);
const RESUME_EVENTS = new Set(["access.unlock_schedule.deactivate"]);

function doorDetails(event) {
  const location = event?.data?.location;
  return {
    id: location?.id ?? event?.data?.device?.location_id,
    name: location?.name ?? event?.data?.device?.alias,
  };
}

function positionFromDoorResponse(door) {
  if (Array.isArray(door)) return door[0]?.door_position_status;
  return door?.door_position_status;
}

function relayFromDoorResponse(door) {
  if (Array.isArray(door)) return door[0]?.door_lock_relay_status;
  return door?.door_lock_relay_status;
}

function ruleTypeFromResponse(rule) {
  const source = Array.isArray(rule) ? rule[0] : rule;
  const value = typeof source === "string"
    ? source
    : source?.type ?? source?.lock_rule?.type ?? source?.rule?.type ?? source?.lock_rule_type;
  return typeof value === "string" ? value : undefined;
}

export class DoorController {
  constructor({
    client,
    monitoredDoorIds = new Set(),
    lockTimeoutMs = 60_000,
    nativeTriggerMs = 1_000,
    nativeTriggerSafetyMs = 250,
    openLockDelayMs = 0,
    dryRun = false,
    automationEnabled = true,
    emergencyActive = false,
    logger,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    onStateChange = () => {},
  }) {
    this.client = client;
    this.monitoredDoorIds = monitoredDoorIds;
    this.lockTimeoutMs = lockTimeoutMs;
    this.nativeTriggerMs = nativeTriggerMs;
    this.nativeTriggerSafetyMs = nativeTriggerSafetyMs;
    this.customUnlockMinutes = Math.max(1, Math.ceil(lockTimeoutMs / 60_000));
    this.openLockDelayMs = openLockDelayMs;
    this.dryRun = dryRun;
    this.automationEnabled = automationEnabled;
    this.emergencyActive = emergencyActive;
    this.logger = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sleep = sleep;
    this.now = now;
    this.onStateChange = onStateChange;
    this.states = new Map();
    this.suspendedDoors = new Set();
    this.lastPositions = new Map();
    this.generations = new Map();
    this.queues = new Map();
  }

  handles(doorId) {
    return Boolean(doorId) && (this.monitoredDoorIds.size === 0 || this.monitoredDoorIds.has(doorId));
  }

  handle(event) {
    if (!this.automationEnabled) return Promise.resolve();

    if (event?.event === "access.device.emergency_status") {
      this.onEmergency(event);
      return Promise.resolve();
    }

    const door = doorDetails(event);
    if (!this.handles(door.id)) return Promise.resolve();

    const previous = this.queues.get(door.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(event, door))
      .catch((error) => {
        this.logger.error("Failed to process UniFi event", {
          event: event?.event,
          doorId: door.id,
          error: error.message,
        });
      });

    this.queues.set(door.id, next);
    next.finally(() => {
      if (this.queues.get(door.id) === next) this.queues.delete(door.id);
    });
    return next;
  }

  async process(event, door) {
    if (SUSPEND_EVENTS.has(event.event)) {
      this.suspendedDoors.add(door.id);
      this.disarm(door.id);
      this.logger.info("Door automation suspended for UniFi unlock rule", { doorId: door.id, door: door.name });
      return;
    }

    if (RESUME_EVENTS.has(event.event)) {
      this.suspendedDoors.delete(door.id);
      this.logger.info("Door automation resumed after UniFi unlock rule", { doorId: door.id, door: door.name });
      return;
    }

    if (event.event === "access.door.unlock") {
      await this.onUnlock(door);
      return;
    }

    if (event.event === "access.device.dps_status") {
      this.onDps(door, event?.data?.object?.status);
    }
  }

  async onUnlock(door) {
    const unlockObservedAt = this.now();
    if (this.emergencyActive || this.suspendedDoors.has(door.id)) {
      this.logger.info("Ignoring unlock while a UniFi emergency or unlock rule is active", {
        doorId: door.id,
        door: door.name,
      });
      return;
    }

    let lockRule;
    try {
      lockRule = await this.client.getLockRule(door.id);
    } catch (error) {
      // Fail safe: the normal UniFi unlock timer remains in control if we cannot
      // prove that this is an ordinary unlock.
      this.logger.warn("Ignoring unlock because the current UniFi lock rule could not be read", {
        doorId: door.id,
        door: door.name,
        error: error.message,
      });
      return;
    }

    const lockRuleType = ruleTypeFromResponse(lockRule);
    if (PROTECTED_LOCK_RULES.has(lockRuleType)) {
      this.logger.info("Ignoring unlock controlled by a UniFi schedule or temporary rule", {
        doorId: door.id,
        door: door.name,
        lockRule: lockRuleType,
      });
      return;
    }

    try {
      await this.client.customUnlock(door.id, this.customUnlockMinutes);
    } catch (error) {
      // The short native UniFi trigger remains the fallback if takeover fails.
      this.logger.error("Could not take over the UniFi unlock with a custom rule", {
        doorId: door.id,
        door: door.name,
        intervalMinutes: this.customUnlockMinutes,
        error: error.message,
      });
      return;
    }

    const handoffLatencyMs = this.now() - unlockObservedAt;
    if (handoffLatencyMs >= this.nativeTriggerMs) {
      this.logger.warn("Custom unlock takeover completed after the configured native trigger window", {
        doorId: door.id,
        door: door.name,
        handoffLatencyMs,
        nativeTriggerMs: this.nativeTriggerMs,
      });
    }

    const currentDoor = await this.client.getDoor(door.id).catch((error) => {
      this.logger.warn("Could not read current DPS state; waiting for the next DPS event", {
        doorId: door.id,
        error: error.message,
      });
      return undefined;
    });

    this.disarm(door.id);
    const generation = (this.generations.get(door.id) ?? 0) + 1;
    this.generations.set(door.id, generation);

    const currentPosition = positionFromDoorResponse(currentDoor) ?? this.lastPositions.get(door.id);
    const state = {
      generation,
      doorId: door.id,
      doorName: door.name,
      currentPosition,
      unlockedAt: unlockObservedAt,
      timeoutAt: unlockObservedAt + this.lockTimeoutMs,
      relockAt: unlockObservedAt + this.lockTimeoutMs,
      // The snapshot is only a baseline. It may be stale, inverted, or reflect
      // a door that was already open before this unlock. Only a fresh DPS
      // transition after the unlock is allowed to trigger an early relock.
      sawOpen: false,
      earliestLockAt: unlockObservedAt + this.nativeTriggerMs + this.nativeTriggerSafetyMs,
      timeoutTimer: undefined,
      lockTimer: undefined,
      locking: false,
    };

    state.timeoutTimer = this.setTimer(
      () => this.scheduleLock(state, "timeout", 0),
      this.lockTimeoutMs,
    );
    state.timeoutTimer?.unref?.();
    this.states.set(door.id, state);
    this.notifyState({ doorId: door.id, relay: "unlock" });

    this.logger.info("Door unlock handed off to a cancellable custom rule", {
      doorId: door.id,
      door: door.name,
      currentPosition: currentPosition ?? "unknown",
      timeoutMs: this.lockTimeoutMs,
      customUnlockMinutes: this.customUnlockMinutes,
      nativeTriggerMs: this.nativeTriggerMs,
      handoffLatencyMs,
    });

  }

  onDps(door, position) {
    if (position !== "open" && position !== "close") {
      this.logger.warn("Ignoring DPS event with unknown status", { doorId: door.id, status: position });
      return;
    }

    this.lastPositions.set(door.id, position);
    const state = this.states.get(door.id);
    if (!state) return;

    const previousPosition = state.currentPosition;
    state.currentPosition = position;
    if (position === "open" && previousPosition !== "open") {
      state.sawOpen = true;
      if (!state.locking && !state.lockTimer) {
        this.scheduleLock(state, "opened", this.openLockDelay(state));
      }
      this.notifyState({ doorId: door.id });
    }
  }

  openLockDelay(state) {
    const nativeWaitMs = Math.max(0, state.earliestLockAt - this.now());
    return nativeWaitMs + this.openLockDelayMs;
  }

  onEmergency(event) {
    const value = event?.data?.object?.value;
    if (typeof value !== "boolean") {
      this.logger.warn("Ignoring emergency event with unknown status", { value });
      return;
    }

    this.emergencyActive = value;
    if (value) {
      for (const doorId of [...this.states.keys()]) this.disarm(doorId);
    }
    this.notifyState({ emergencyActive: value });
    this.logger.warn(value ? "Door automation suspended for UniFi emergency mode" : "Door automation resumed after UniFi emergency mode", {
      mode: event?.data?.object?.mode,
    });
  }

  scheduleLock(state, reason, delayMs) {
    const current = this.states.get(state.doorId);
    if (current?.generation !== state.generation || current.locking) return;
    if (reason === "opened" && !current.sawOpen) return;

    current.relockAt = Math.min(current.timeoutAt, this.now() + delayMs);

    current.lockTimer = this.setTimer(() => {
      current.lockTimer = undefined;
      void this.lockWithRetry(current, reason);
    }, delayMs);
    current.lockTimer?.unref?.();
  }

  async lockWithRetry(state, reason) {
    if (this.emergencyActive) {
      this.disarm(state.doorId, state.generation);
      return;
    }

    let current = this.states.get(state.doorId);
    if (current?.generation !== state.generation || current.locking) return;
    current.locking = true;
    this.notifyState({ doorId: state.doorId });

    const retryDelays = [0, 250, 1_000, 3_000];
    let lastError;
    for (const retryDelay of retryDelays) {
      if (retryDelay) await this.sleep(retryDelay);
      current = this.states.get(state.doorId);
      if (current?.generation !== state.generation) return;
      if (this.emergencyActive) {
        this.disarm(state.doorId, state.generation);
        return;
      }
      try {
        if (!this.dryRun) {
          await this.client.lockNow(state.doorId);
          await this.sleep(200);
          const verifiedDoor = await this.client.getDoor(state.doorId);
          if (relayFromDoorResponse(verifiedDoor) === "unlock") {
            throw new Error("UniFi accepted lock_now but the relay remains unlocked");
          }
        }
        this.logger.info(this.dryRun ? "Would lock door (dry run)" : "Door locked", {
          doorId: state.doorId,
          door: state.doorName,
          reason,
        });
        this.disarm(state.doorId, state.generation);
        this.notifyState({ doorId: state.doorId, ...(!this.dryRun ? { relay: "lock" } : {}) });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.logger.error("Failed to lock door; the custom unlock rule remains the fallback", {
      doorId: state.doorId,
      door: state.doorName,
      reason,
      error: lastError?.message,
    });
    this.disarm(state.doorId, state.generation);
    this.notifyState({ doorId: state.doorId });
  }

  notifyState(change) {
    try {
      this.onStateChange(change);
    } catch (error) {
      this.logger.warn("Door state observer failed", { doorId: change.doorId, error: error.message });
    }
  }

  disarm(doorId, generation) {
    const state = this.states.get(doorId);
    if (!state || (generation !== undefined && state.generation !== generation)) return;
    if (state.timeoutTimer) this.clearTimer(state.timeoutTimer);
    if (state.lockTimer) this.clearTimer(state.lockTimer);
    this.states.delete(doorId);
  }

  snapshot() {
    return [...this.states.values()].map((state) => ({
      doorId: state.doorId,
      door: state.doorName,
      position: state.currentPosition ?? "unknown",
      sawOpen: state.sawOpen,
      locking: state.locking,
      unlockedAt: state.unlockedAt,
      relockAt: state.relockAt,
    }));
  }

  stop() {
    for (const doorId of [...this.states.keys()]) this.disarm(doorId);
    this.queues.clear();
  }
}
