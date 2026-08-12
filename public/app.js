const elements = {
  form: document.querySelector("#config-form"),
  statusPill: document.querySelector("#status-pill"),
  statusLabel: document.querySelector("#status-label"),
  liveTitle: document.querySelector("#live-title"),
  runtimeMessage: document.querySelector("#runtime-message"),
  doorCount: document.querySelector("#door-count"),
  armedCount: document.querySelector("#armed-count"),
  modeLabel: document.querySelector("#mode-label"),
  doorList: document.querySelector("#door-list"),
  liveDpsSource: document.querySelector("#live-dps-source"),
  tokenState: document.querySelector("#token-state"),
  webhookSecretState: document.querySelector("#webhook-secret-state"),
  adminPasswordState: document.querySelector("#admin-password-state"),
  webhookSecretField: document.querySelector("#webhook-secret-field"),
  webhookTest: document.querySelector("#webhook-test"),
  webhookTestButton: document.querySelector("#webhook-test-button"),
  webhookTestIcon: document.querySelector("#webhook-test-icon"),
  webhookTestTitle: document.querySelector("#webhook-test-title"),
  webhookTestMessage: document.querySelector("#webhook-test-message"),
  lockApiTest: document.querySelector("#lock-api-test"),
  lockApiTestIcon: document.querySelector("#lock-api-test-icon"),
  lockApiTestTitle: document.querySelector("#lock-api-test-title"),
  lockApiTestMessage: document.querySelector("#lock-api-test-message"),
  lockTestDoor: document.querySelector("#lock-test-door"),
  lockTestCommand: document.querySelector("#lock-test-command"),
  lockTestButton: document.querySelector("#lock-test-button"),
  automationEnabled: document.querySelector("#automation-enabled"),
  mqttEnabled: document.querySelector("#mqtt-enabled"),
  mqttPasswordState: document.querySelector("#mqtt-password-state"),
  mqttStatus: document.querySelector("#mqtt-status"),
  mqttStatusIcon: document.querySelector("#mqtt-status-icon"),
  mqttStatusTitle: document.querySelector("#mqtt-status-title"),
  mqttStatusMessage: document.querySelector("#mqtt-status-message"),
  autoWebhook: document.querySelector("#auto-webhook"),
  securityNote: document.querySelector("#security-note"),
  testButton: document.querySelector("#test-button"),
  saveButton: document.querySelector("#save-button"),
  selectAllButton: document.querySelector("#select-all-button"),
  refreshButton: document.querySelector("#refresh-button"),
  unsavedDot: document.querySelector("#unsaved-dot"),
  saveState: document.querySelector("#save-state"),
  saveHelp: document.querySelector("#save-help"),
  toastRegion: document.querySelector("#toast-region"),
  loginDialog: document.querySelector("#login-dialog"),
  loginForm: document.querySelector("#login-form"),
  loginUsername: document.querySelector("#login-username"),
  loginPassword: document.querySelector("#login-password"),
  loginError: document.querySelector("#login-error"),
};

const state = {
  authorization: sessionStorage.getItem("doorstateAuthorization") || "",
  settings: undefined,
  doors: [],
  selectedDoorIds: new Set(),
  dirty: false,
  retryAfterLogin: undefined,
  runtime: undefined,
  webhookTestTimer: undefined,
  statusWatchStarted: false,
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function basicAuthorization(username, password) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function localUrl(path) {
  const base = new URL(window.location.href);
  base.search = "";
  base.hash = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(path.replace(/^\/+/, ""), base);
}

async function api(path, options = {}, allowLogin = true) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.authorization) headers.authorization = state.authorization;
  const response = await fetch(localUrl(path), { ...options, headers });

  if (response.status === 401 && allowLogin) {
    state.retryAfterLogin = () => api(path, options, false);
    showLogin();
    throw new Error("Sign in required");
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function showLogin() {
  elements.loginError.textContent = "";
  elements.loginPassword.value = "";
  if (!elements.loginDialog.open) elements.loginDialog.showModal();
  requestAnimationFrame(() => elements.loginUsername.focus());
}

function toast(message, type = "success") {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  setTimeout(() => node.remove(), 5_000);
}

function markDirty(dirty = true) {
  state.dirty = dirty;
  elements.unsavedDot.classList.toggle("changed", dirty);
  elements.saveState.textContent = dirty ? "Unsaved changes" : "Configuration saved";
  elements.saveHelp.textContent = dirty
    ? "Test the connection, then save when you are ready."
    : "Changes are stored locally on this device.";
  updateWebhookTestAvailability();
  updateLockTestAvailability();
}

function updateLockTestAvailability() {
  const running = elements.lockApiTest.classList.contains("waiting");
  const ready = state.runtime?.phase === "ready";
  const hasDoor = Boolean(elements.lockTestDoor.value);
  elements.lockTestDoor.disabled = running || !ready || !hasDoor;
  elements.lockTestCommand.disabled = running || !ready;
  elements.lockTestButton.disabled = running || !ready || !hasDoor;

  if (!running && !ready) {
    elements.lockApiTestMessage.textContent = "The service must be connected before testing a door command.";
  } else if (
    !running
    && !elements.lockApiTest.classList.contains("success")
    && !elements.lockApiTest.classList.contains("failed")
  ) {
    elements.lockApiTestMessage.textContent = "Set UniFi’s native trigger to 1 second, then run handoff_1s.";
  }
}

function updateWebhookTestAvailability() {
  const running = elements.webhookTest.classList.contains("waiting");
  elements.webhookTestButton.disabled = running || state.dirty || state.runtime?.phase !== "ready";
  if (!running && state.dirty) {
    elements.webhookTestMessage.textContent = "Save and apply your changes before testing delivery.";
  } else if (!running && state.runtime?.phase !== "ready") {
    elements.webhookTestMessage.textContent = "The automation must be connected before testing delivery.";
  } else if (
    !running
    && !elements.webhookTest.classList.contains("success")
    && !elements.webhookTest.classList.contains("failed")
  ) {
    elements.webhookTestMessage.textContent = "Listen for a signed event sent by your UniFi console.";
  }
}

function setValue(id, value) {
  const input = document.querySelector(`#${id}`);
  if (input.type === "checkbox") input.checked = Boolean(value);
  else input.value = value ?? "";
}

function populate(settings) {
  clearTimeout(state.webhookTestTimer);
  setWebhookTestState(null, "Verify live delivery", "Listen for a signed event sent by your UniFi console.");
  setLockTestState(null, "Test the door API directly", "Set UniFi’s native trigger to 1 second, then run handoff_1s.");
  state.settings = settings;
  state.selectedDoorIds = new Set(settings.doorIds || []);
  setValue("unifi-access-url", settings.unifiAccessUrl);
  setValue("tls-verify", settings.tlsRejectUnauthorized);
  setValue("webhook-public-url", settings.webhookPublicUrl || suggestedWebhookUrl());
  setValue("auto-webhook", settings.autoRegisterWebhook);
  setValue("automation-enabled", settings.automationEnabled);
  setValue("lock-timeout", settings.lockTimeoutSeconds);
  setValue("native-trigger", settings.nativeTriggerSeconds ?? 1);
  setValue("open-lock-delay", settings.openLockDelayMs ?? settings.closeDebounceMs ?? 0);
  setValue("mqtt-enabled", settings.mqttEnabled);
  setValue("mqtt-broker-url", settings.mqttBrokerUrl);
  setValue("mqtt-username", settings.mqttUsername);
  setValue("mqtt-discovery-prefix", settings.mqttDiscoveryPrefix || "homeassistant");
  setValue("mqtt-topic-prefix", settings.mqttTopicPrefix || "doorstate");
  setValue("mqtt-allow-unlock", settings.mqttAllowUnlock);
  setValue("port", settings.port);
  setValue("webhook-path", settings.webhookPath);
  setValue("webhook-name", settings.webhookName);
  setValue("request-timeout", settings.requestTimeoutMs);
  setValue("signature-tolerance", settings.signatureToleranceSeconds);
  setValue("admin-username", settings.adminUsername);

  elements.tokenState.textContent = settings.apiTokenConfigured ? "saved" : "required";
  elements.webhookSecretState.textContent = settings.webhookSecretConfigured ? "saved" : "required";
  elements.adminPasswordState.textContent = settings.adminPasswordConfigured ? "saved" : "recommended";
  elements.mqttPasswordState.textContent = settings.mqttPasswordConfigured ? "saved" : "optional";
  elements.webhookSecretField.classList.toggle("hidden", settings.autoRegisterWebhook);

  elements.securityNote.classList.toggle("secured", settings.adminPasswordConfigured);
  elements.securityNote.innerHTML = settings.adminPasswordConfigured
    ? '<span aria-hidden="true">✓</span><p><strong>Administrator access protected</strong>Configuration APIs require your local sign-in.</p>'
    : '<span aria-hidden="true">!</span><p><strong>Administrator password not set</strong>This setup page is currently open to your local network.</p>';
  updateAutomationFields();
  updateMqttFields();
  markDirty(false);
}

function updateAutomationFields() {
  const disabled = !elements.automationEnabled.checked;
  document.querySelector("#lock-timeout").disabled = disabled;
  document.querySelector("#native-trigger").disabled = disabled;
  document.querySelector("#open-lock-delay").disabled = disabled;
}

function updateMqttFields() {
  const disabled = !elements.mqttEnabled.checked;
  document.querySelector("#mqtt-broker-url").disabled = disabled;
  document.querySelector("#mqtt-username").disabled = disabled;
  document.querySelector("#mqtt-password").disabled = disabled;
  document.querySelector("#mqtt-discovery-prefix").disabled = disabled;
  document.querySelector("#mqtt-topic-prefix").disabled = disabled;
  document.querySelector("#mqtt-allow-unlock").disabled = disabled;
}

function suggestedWebhookUrl() {
  const host = window.location.hostname || "raspberry-pi";
  const port = document.querySelector("#port")?.value || window.location.port || "8080";
  return `http://${host}:${port}/webhooks/unifi`;
}

function phaseText(phase) {
  return {
    ready: "Active",
    connecting: "Connecting",
    error: "Needs attention",
    setup: "Setup required",
    "restart-required": "Restart required",
  }[phase] || "Unknown";
}

function updateRuntime(runtime) {
  state.runtime = runtime;
  const phase = runtime?.phase || "setup";
  elements.statusPill.className = `status-pill status-${phase === "restart-required" ? "setup" : phase}`;
  elements.statusLabel.textContent = phaseText(phase);
  elements.liveTitle.textContent = {
    ready: runtime.automationEnabled ? "Relock is active" : "Connected, monitoring only",
    connecting: "Connecting to Access",
    error: "Connection needs attention",
    setup: "Waiting for setup",
    "restart-required": "Saved, restart needed",
  }[phase] || "Service status";
  elements.runtimeMessage.textContent = runtime?.message || "No status available";
  elements.doorCount.textContent = runtime?.doors?.length ?? state.doors.length ?? "—";
  elements.armedCount.textContent = runtime?.armedDoors?.length ?? 0;
  elements.modeLabel.textContent = runtime?.emergencyActive
    ? "Emergency"
    : phase === "ready" && runtime?.automationEnabled === false
      ? "Monitor"
      : runtime?.dryRun
        ? "Dry run"
        : phase === "ready"
          ? "Live"
          : "Standby";
  elements.liveDpsSource.classList.toggle("active", phase === "ready");
  elements.liveDpsSource.querySelector("b").textContent = phase === "ready" ? "Live DPS" : "DPS offline";

  const homeAssistant = runtime?.homeAssistant || { enabled: false, phase: "disabled" };
  elements.mqttStatus.classList.remove("success", "failed", "waiting");
  if (!homeAssistant.enabled || homeAssistant.phase === "disabled") {
    elements.mqttStatusTitle.textContent = "MQTT disabled";
    elements.mqttStatusMessage.textContent = "Enable MQTT discovery to create native Home Assistant devices.";
    elements.mqttStatusIcon.textContent = "⌁";
  } else if (homeAssistant.phase === "connected") {
    elements.mqttStatus.classList.add("success");
    elements.mqttStatusTitle.textContent = "Home Assistant connected";
    elements.mqttStatusMessage.textContent = `${homeAssistant.source || "MQTT"} broker ${homeAssistant.broker || "connected"}; native entities are published.`;
    elements.mqttStatusIcon.textContent = "✓";
  } else if (homeAssistant.phase === "error") {
    elements.mqttStatus.classList.add("failed");
    elements.mqttStatusTitle.textContent = "MQTT connection failed";
    elements.mqttStatusMessage.textContent = homeAssistant.error || "Check the broker URL and credentials.";
    elements.mqttStatusIcon.textContent = "!";
  } else {
    elements.mqttStatus.classList.add("waiting");
    elements.mqttStatusTitle.textContent = homeAssistant.phase === "connecting" ? "Connecting to MQTT" : "MQTT offline";
    elements.mqttStatusMessage.textContent = "Door automation remains active independently while MQTT reconnects.";
    elements.mqttStatusIcon.textContent = "…";
  }

  if (runtime?.doors) {
    if (state.dirty && state.doors.length) {
      const liveDoors = new Map(runtime.doors.map((door) => [door.id, door]));
      state.doors = state.doors.map((door) => {
        const live = liveDoors.get(door.id);
        return live
          ? { ...door, position: live.position, hasDps: live.hasDps, lastDpsAt: live.lastDpsAt }
          : door;
      });
    } else {
      state.doors = runtime.doors;
    }
    renderDoors();
    renderLockTestDoors(runtime.doors);
  }
  updateWebhookTestAvailability();
}

function renderLockTestDoors(doors = []) {
  const previous = elements.lockTestDoor.value;
  elements.lockTestDoor.replaceChildren(
    ...doors.map((door) => {
      const option = document.createElement("option");
      option.value = door.id;
      option.textContent = door.name || door.fullName || door.id;
      return option;
    }),
  );
  if (doors.some((door) => door.id === previous)) elements.lockTestDoor.value = previous;
  updateLockTestAvailability();
}

function setLockTestState(status, title, message) {
  elements.lockApiTest.classList.remove("waiting", "success", "failed");
  if (status) elements.lockApiTest.classList.add(status);
  elements.lockApiTestIcon.textContent = status === "success" ? "✓" : "!";
  elements.lockApiTestTitle.textContent = title;
  elements.lockApiTestMessage.textContent = message;
  updateLockTestAvailability();
}

async function testDoorCommand() {
  const doorId = elements.lockTestDoor.value;
  const doorName = elements.lockTestDoor.selectedOptions[0]?.textContent || "this door";
  const command = elements.lockTestCommand.value;
  if (!doorId) return;
  const confirmation = command === "handoff_1s"
    ? `Run the complete handoff test on ${doorName}? First set UniFi's native lock trigger duration to exactly 1 second. This test will unlock the real latch, apply a one-minute custom unlock, wait for the native trigger to expire, then send lock_now.`
    : `Send ${command} to ${doorName}? This operates the real relay and bypasses monitor-only mode.`;
  if (!window.confirm(confirmation)) return;

  setLockTestState("waiting", `Sending ${command}`, `Asking UniFi to apply ${command} to ${doorName}…`);
  try {
    const result = await api("/api/lock-test", {
      method: "POST",
      body: JSON.stringify({ doorId, command }),
    });
    const afterNote = result.afterReadError ? ` The follow-up read failed: ${result.afterReadError}.` : "";
    const handoffReadNote = result.handoffReadError ? ` The handoff-state read failed: ${result.handoffReadError}.` : "";
    if (result.command === "handoff_1s") {
      const locked = result.afterRelay === "lock";
      setLockTestState(
        locked ? "success" : "failed",
        locked ? "Handoff test re-locked the door" : "Handoff test did not re-lock",
        `${result.doorName}: before ${result.beforeRelay}/${result.beforeRule}; after native expiry ${result.handoffRelay ?? "unknown"}/${result.handoffRule ?? "unknown"}; after lock_now ${result.afterRelay}/${result.afterRule}; DPS ${result.afterPosition}.${handoffReadNote}${afterNote}`,
      );
      toast(
        locked ? "The one-second handoff design worked." : "The relay remained unlocked after the handoff test.",
        locked ? "success" : "error",
      );
      return;
    }
    const nextStep = result.command === "custom"
      ? " If the latch released, select lock_now and send it before the one-minute fallback expires."
      : result.command === "unlock"
        ? " This native trigger cannot be cancelled on this hub; use custom for the next test."
      : " Check whether the latch and relay changed immediately.";
    setLockTestState(
      "success",
      "Command accepted by UniFi",
      `${result.doorName}: relay ${result.beforeRelay} → ${result.afterRelay}; DPS ${result.afterPosition}; rule ${result.beforeRule} → ${result.afterRule}.${nextStep}${handoffReadNote}${afterNote}`,
    );
    toast(`UniFi accepted ${result.command} for ${result.doorName}.`);
  } catch (error) {
    if (error.message !== "Sign in required") {
      setLockTestState("failed", "Door API test failed", error.message);
      toast(error.message, "error");
    }
  }
}

function setWebhookTestState(status, title, message) {
  elements.webhookTest.classList.remove("waiting", "success", "failed");
  if (status) elements.webhookTest.classList.add(status);
  elements.webhookTestIcon.textContent = status === "success" ? "✓" : status === "failed" ? "!" : "↗";
  elements.webhookTestTitle.textContent = title;
  elements.webhookTestMessage.textContent = message;
  updateWebhookTestAvailability();
}

async function pollWebhookTest(testId) {
  try {
    const result = await api(`/api/webhook-test/${encodeURIComponent(testId)}`);
    if (result.status === "waiting") {
      const seconds = Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1_000));
      elements.webhookTestMessage.textContent = `Listening… unlock or move a door within ${seconds} seconds.`;
      state.webhookTestTimer = setTimeout(() => pollWebhookTest(testId), 1_000);
      return;
    }

    if (result.status === "received") {
      const eventLabel = result.event || "signed event";
      const doorLabel = result.doorName ? ` for ${result.doorName}` : "";
      setWebhookTestState("success", "Webhook received", `${eventLabel}${doorLabel} arrived from UniFi.`);
      toast("Webhook delivery verified end to end.");
      return;
    }

    setWebhookTestState("failed", "No webhook received", "The listening window expired. Check the callback URL, firewall and VLAN access.");
  } catch (error) {
    if (error.message !== "Sign in required") {
      setWebhookTestState("failed", "Webhook test failed", error.message);
      toast(error.message, "error");
    }
  }
}

async function startWebhookTest() {
  clearTimeout(state.webhookTestTimer);
  elements.webhookTestButton.disabled = true;
  setWebhookTestState("waiting", "Waiting for UniFi", "Checking the subscription…");
  try {
    const test = await api("/api/webhook-test", { method: "POST" });
    elements.webhookTestMessage.textContent = "Listening… unlock or move a door within 60 seconds.";
    await pollWebhookTest(test.id);
  } catch (error) {
    if (error.message !== "Sign in required") {
      setWebhookTestState("failed", "Webhook test failed", error.message);
      toast(error.message, "error");
    }
  }
}

function renderDoors() {
  if (!state.doors.length) {
    elements.doorList.innerHTML = '<div class="empty-state"><span aria-hidden="true">⌁</span><strong>No doors loaded yet</strong><p>Test the connection to retrieve doors from UniFi Access.</p></div>';
    return;
  }

  const allMode = state.selectedDoorIds.size === 0;
  elements.doorList.replaceChildren(
    ...state.doors.map((door) => {
      const option = document.createElement("div");
      option.className = "door-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = `door-${door.id}`;
      input.value = door.id;
      input.checked = allMode || state.selectedDoorIds.has(door.id);
      input.addEventListener("change", onDoorSelectionChange);
      const label = document.createElement("label");
      label.htmlFor = input.id;
      const check = document.createElement("span");
      check.className = "door-check";
      check.textContent = "✓";
      const copy = document.createElement("span");
      copy.className = "door-copy";
      const name = document.createElement("strong");
      name.textContent = door.name || door.fullName || door.id;
      const detail = document.createElement("span");
      detail.textContent = door.fullName || `ID ${door.id}`;
      copy.append(name, detail);
      const badge = document.createElement("span");
      const dps = dpsPresentation(door);
      badge.className = `dps-badge ${dps.className}`;
      badge.textContent = dps.label;
      badge.setAttribute("aria-label", dps.ariaLabel);
      badge.title = door.lastDpsAt
        ? `Last DPS event ${new Date(door.lastDpsAt).toLocaleTimeString()}`
        : dps.title;
      label.append(check, copy, badge);
      option.append(input, label);
      return option;
    }),
  );
}

function dpsPresentation(door) {
  if (!door.hasDps) {
    return {
      className: "dps-missing",
      label: "No DPS",
      ariaLabel: "Door position sensor unavailable",
      title: "UniFi reports no door position sensor for this door",
    };
  }
  if (door.position === "open") {
    return {
      className: "dps-open",
      label: "Open",
      ariaLabel: "Door position: open",
      title: "Current DPS position: open",
    };
  }
  if (door.position === "close" || door.position === "closed") {
    return {
      className: "dps-closed",
      label: "Closed",
      ariaLabel: "Door position: closed",
      title: "Current DPS position: closed",
    };
  }
  return {
    className: "dps-unknown",
    label: "Unknown",
    ariaLabel: "Door position unknown",
    title: "Waiting for a DPS position from UniFi",
  };
}

function onDoorSelectionChange(event) {
  const checkboxes = [...elements.doorList.querySelectorAll('input[type="checkbox"]')];
  let selected = checkboxes.filter((input) => input.checked).map((input) => input.value);
  if (checkboxes.length && selected.length === 0 && event?.target) {
    event.target.checked = true;
    selected = [event.target.value];
    toast("Select at least one door. Turn off automatic DPS relocking to monitor without relay actions.", "error");
  }
  state.selectedDoorIds = selected.length === checkboxes.length ? new Set() : new Set(selected);
  markDirty();
}

function formPayload() {
  const selected = [...elements.doorList.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  const allSelected = state.doors.length > 0 && selected.length === state.doors.length;
  const doorIds = state.doors.length === 0
    ? [...state.selectedDoorIds]
    : allSelected
      ? []
      : selected;
  return {
    unifiAccessUrl: document.querySelector("#unifi-access-url").value,
    apiToken: document.querySelector("#api-token").value,
    tlsRejectUnauthorized: document.querySelector("#tls-verify").checked,
    requestTimeoutMs: Number(document.querySelector("#request-timeout").value),
    webhookPublicUrl: document.querySelector("#webhook-public-url").value,
    webhookPath: document.querySelector("#webhook-path").value,
    autoRegisterWebhook: document.querySelector("#auto-webhook").checked,
    webhookName: document.querySelector("#webhook-name").value,
    webhookSecret: document.querySelector("#webhook-secret").value,
    doorIds,
    automationEnabled: elements.automationEnabled.checked,
    lockTimeoutSeconds: Number(document.querySelector("#lock-timeout").value),
    nativeTriggerSeconds: Number(document.querySelector("#native-trigger").value),
    openLockDelayMs: Number(document.querySelector("#open-lock-delay").value),
    mqttEnabled: elements.mqttEnabled.checked,
    mqttBrokerUrl: document.querySelector("#mqtt-broker-url").value,
    mqttUsername: document.querySelector("#mqtt-username").value,
    mqttPassword: document.querySelector("#mqtt-password").value,
    mqttDiscoveryPrefix: document.querySelector("#mqtt-discovery-prefix").value,
    mqttTopicPrefix: document.querySelector("#mqtt-topic-prefix").value,
    mqttAllowUnlock: document.querySelector("#mqtt-allow-unlock").checked,
    signatureToleranceSeconds: Number(document.querySelector("#signature-tolerance").value),
    port: Number(document.querySelector("#port").value),
    adminUsername: document.querySelector("#admin-username").value,
    adminPassword: document.querySelector("#admin-password").value,
  };
}

async function loadConfiguration() {
  try {
    const result = await api("/api/config");
    populate(result.settings);
    state.doors = result.runtime?.doors || [];
    updateRuntime(result.runtime);
    renderDoors();
    if (result.configurationError) {
      elements.runtimeMessage.textContent = `Complete the required fields: ${result.configurationError}`;
    }
    startStatusWatch();
  } catch (error) {
    if (error.message !== "Sign in required") toast(error.message, "error");
  }
}

function startStatusWatch() {
  if (state.statusWatchStarted) return;
  state.statusWatchStarted = true;
  void watchStatus();
}

async function watchStatus() {
  while (state.statusWatchStarted) {
    if (document.hidden || elements.loginDialog.open) {
      await delay(500);
      continue;
    }

    try {
      const revision = state.runtime?.revision ?? 0;
      const result = await api(`/api/status?since=${encodeURIComponent(revision)}`, {}, false);
      updateRuntime(result.runtime);
    } catch (error) {
      if (error.message === "Administrator sign-in required") {
        if (!elements.loginDialog.open) showLogin();
      }
      await delay(2_000);
    }
  }
}

async function refreshStatus() {
  try {
    const result = await api("/api/status");
    updateRuntime(result.runtime);
  } catch (error) {
    if (error.message !== "Sign in required") toast(error.message, "error");
  }
}

async function testConnection() {
  if (!elements.form.reportValidity()) return;
  elements.testButton.disabled = true;
  const original = elements.testButton.innerHTML;
  elements.testButton.textContent = "Testing connection…";
  try {
    const result = await api("/api/test-connection", { method: "POST", body: JSON.stringify(formPayload()) });
    state.doors = result.doors || [];
    renderDoors();
    toast(`Connected. Found ${state.doors.length} door${state.doors.length === 1 ? "" : "s"}.`);
  } catch (error) {
    if (error.message !== "Sign in required") toast(error.message, "error");
  } finally {
    elements.testButton.disabled = false;
    elements.testButton.innerHTML = original;
  }
}

async function saveConfiguration(event) {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;
  elements.saveButton.disabled = true;
  try {
    const payload = formPayload();
    const result = await api("/api/config", { method: "PUT", body: JSON.stringify(payload) });

    if (payload.adminPassword) {
      state.authorization = basicAuthorization(payload.adminUsername || "admin", payload.adminPassword);
      sessionStorage.setItem("doorstateAuthorization", state.authorization);
      document.querySelector("#admin-password").value = "";
    }
    document.querySelector("#api-token").value = "";
    document.querySelector("#webhook-secret").value = "";
    document.querySelector("#mqtt-password").value = "";
    populate(result.settings);
    toast(result.message);
    if (!result.restartRequired) {
      setTimeout(refreshStatus, 500);
      setTimeout(refreshStatus, 1_800);
    } else {
      updateRuntime({ phase: "restart-required", message: result.message, doors: state.doors, armedDoors: [] });
    }
  } catch (error) {
    if (error.message !== "Sign in required") toast(error.message, "error");
  } finally {
    elements.saveButton.disabled = false;
  }
}

elements.form.addEventListener("input", (event) => {
  if (!elements.lockApiTest.contains(event.target)) markDirty();
});
elements.form.addEventListener("change", (event) => {
  if (!elements.lockApiTest.contains(event.target)) markDirty();
});
elements.form.addEventListener("submit", saveConfiguration);
elements.testButton.addEventListener("click", testConnection);
elements.webhookTestButton.addEventListener("click", startWebhookTest);
elements.lockTestButton.addEventListener("click", testDoorCommand);
elements.refreshButton.addEventListener("click", refreshStatus);
elements.autoWebhook.addEventListener("change", () => {
  elements.webhookSecretField.classList.toggle("hidden", elements.autoWebhook.checked);
});
elements.automationEnabled.addEventListener("change", updateAutomationFields);
elements.mqttEnabled.addEventListener("change", updateMqttFields);
elements.selectAllButton.addEventListener("click", () => {
  const checkboxes = [...elements.doorList.querySelectorAll('input[type="checkbox"]')];
  for (const checkbox of checkboxes) checkbox.checked = true;
  onDoorSelectionChange();
});

document.querySelectorAll("[data-reveal]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector(`#${button.dataset.reveal}`);
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
  });
});

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  state.authorization = basicAuthorization(elements.loginUsername.value, elements.loginPassword.value);
  sessionStorage.setItem("doorstateAuthorization", state.authorization);
  elements.loginError.textContent = "";
  try {
    if (state.retryAfterLogin) await state.retryAfterLogin();
    elements.loginDialog.close();
    await loadConfiguration();
  } catch (error) {
    state.authorization = "";
    sessionStorage.removeItem("doorstateAuthorization");
    elements.loginError.textContent = error.message === "Sign in required" ? "Incorrect username or password." : error.message;
  }
});

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
});

void loadConfiguration();
