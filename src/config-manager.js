import { hashPassword, isAdminAuthenticationConfigured } from "./admin-auth.js";
import { readConfig } from "./config.js";

const RUNTIME_KEYS = [
  "UNIFI_ACCESS_URL",
  "UNIFI_API_TOKEN",
  "UNIFI_TLS_REJECT_UNAUTHORIZED",
  "UNIFI_REQUEST_TIMEOUT_MS",
  "WEBHOOK_PUBLIC_URL",
  "WEBHOOK_PATH",
  "AUTO_REGISTER_WEBHOOK",
  "WEBHOOK_NAME",
  "WEBHOOK_SECRET",
  "DOOR_IDS",
  "AUTOMATIC_DPS_RELOCK_ENABLED",
  "LOCK_TIMEOUT_MS",
  "NATIVE_TRIGGER_MS",
  "OPEN_LOCK_DELAY_MS",
  "CLOSE_DEBOUNCE_MS",
  "WEBHOOK_SIGNATURE_TOLERANCE_SECONDS",
  "PORT",
  "DRY_RUN",
];

function boolString(value) {
  return value ? "true" : "false";
}

function bodyString(body, key, fallback = "") {
  const value = body[key];
  return typeof value === "string" ? value.trim() : fallback;
}

function numberString(body, key, fallback) {
  if (body[key] === undefined || body[key] === "") return String(fallback);
  return String(Number(body[key]));
}

function effectiveBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  return /^(true|1|yes)$/i.test(value);
}

function effectiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function effectiveNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export class ConfigManager {
  constructor({ store, baseEnvironment = process.env }) {
    this.store = store;
    this.baseEnvironment = { ...baseEnvironment };
    this.stored = {};
  }

  async load() {
    this.stored = await this.store.read();
  }

  environment() {
    return { ...this.baseEnvironment, ...this.stored };
  }

  authenticationConfigured() {
    return isAdminAuthenticationConfigured(this.environment());
  }

  tryConfig() {
    try {
      return { config: readConfig(this.environment()), error: undefined };
    } catch (error) {
      return { config: undefined, error: error.message };
    }
  }

  publicSettings() {
    const environment = this.environment();
    return {
      unifiAccessUrl: environment.UNIFI_ACCESS_URL || "",
      apiTokenConfigured: Boolean(environment.UNIFI_API_TOKEN),
      tlsRejectUnauthorized: effectiveBoolean(environment.UNIFI_TLS_REJECT_UNAUTHORIZED, true),
      requestTimeoutMs: effectiveNumber(environment.UNIFI_REQUEST_TIMEOUT_MS, 5_000),
      webhookPublicUrl: environment.WEBHOOK_PUBLIC_URL || "",
      webhookPath: environment.WEBHOOK_PATH || "/webhooks/unifi",
      autoRegisterWebhook: effectiveBoolean(environment.AUTO_REGISTER_WEBHOOK, true),
      webhookName: environment.WEBHOOK_NAME || "unifi-access-lock",
      webhookSecretConfigured: Boolean(environment.WEBHOOK_SECRET),
      doorIds: (environment.DOOR_IDS || "").split(",").map((id) => id.trim()).filter(Boolean),
      automationEnabled: effectiveBoolean(environment.AUTOMATIC_DPS_RELOCK_ENABLED, false)
        && !effectiveBoolean(environment.DRY_RUN, false),
      lockTimeoutSeconds: effectiveNumber(environment.LOCK_TIMEOUT_MS, 60_000) / 1_000,
      nativeTriggerSeconds: effectiveNumber(environment.NATIVE_TRIGGER_MS, 1_000) / 1_000,
      openLockDelayMs: effectiveNonNegativeNumber(
        environment.OPEN_LOCK_DELAY_MS,
        effectiveNumber(environment.CLOSE_DEBOUNCE_MS, 0),
      ),
      // Kept temporarily so a page loaded before a service restart can still
      // display the migrated value.
      closeDebounceMs: effectiveNonNegativeNumber(
        environment.OPEN_LOCK_DELAY_MS,
        effectiveNumber(environment.CLOSE_DEBOUNCE_MS, 0),
      ),
      signatureToleranceSeconds: effectiveNumber(
        environment.WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
        300,
      ),
      port: effectiveNumber(environment.PORT, 8_080),
      dryRun: effectiveBoolean(environment.DRY_RUN, false),
      adminUsername: environment.ADMIN_USERNAME || "admin",
      adminPasswordConfigured: isAdminAuthenticationConfigured(environment),
    };
  }

  candidate(body) {
    const current = this.environment();
    const environment = { ...current };

    environment.UNIFI_ACCESS_URL = bodyString(body, "unifiAccessUrl");
    if (bodyString(body, "apiToken")) environment.UNIFI_API_TOKEN = bodyString(body, "apiToken");
    environment.UNIFI_TLS_REJECT_UNAUTHORIZED = boolString(Boolean(body.tlsRejectUnauthorized));
    environment.UNIFI_REQUEST_TIMEOUT_MS = numberString(
      body,
      "requestTimeoutMs",
      effectiveNumber(current.UNIFI_REQUEST_TIMEOUT_MS, 5_000),
    );
    environment.WEBHOOK_PUBLIC_URL = bodyString(body, "webhookPublicUrl");
    environment.WEBHOOK_PATH = bodyString(body, "webhookPath", "/webhooks/unifi");
    environment.AUTO_REGISTER_WEBHOOK = boolString(Boolean(body.autoRegisterWebhook));
    environment.WEBHOOK_NAME = bodyString(body, "webhookName", "unifi-access-lock");
    if (bodyString(body, "webhookSecret")) {
      environment.WEBHOOK_SECRET = bodyString(body, "webhookSecret");
    }
    environment.DOOR_IDS = Array.isArray(body.doorIds)
      ? body.doorIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()).join(",")
      : "";
    environment.AUTOMATIC_DPS_RELOCK_ENABLED = boolString(Boolean(body.automationEnabled));
    environment.LOCK_TIMEOUT_MS = String(Number(body.lockTimeoutSeconds) * 1_000);
    environment.NATIVE_TRIGGER_MS = body.nativeTriggerSeconds === undefined || body.nativeTriggerSeconds === ""
      ? String(effectiveNumber(current.NATIVE_TRIGGER_MS, 1_000))
      : String(Number(body.nativeTriggerSeconds) * 1_000);
    const currentOpenLockDelayMs = effectiveNonNegativeNumber(
      current.OPEN_LOCK_DELAY_MS,
      effectiveNumber(current.CLOSE_DEBOUNCE_MS, 0),
    );
    const requestedOpenLockDelayMs = body.openLockDelayMs ?? body.closeDebounceMs;
    environment.OPEN_LOCK_DELAY_MS = requestedOpenLockDelayMs === undefined || requestedOpenLockDelayMs === ""
      ? String(currentOpenLockDelayMs)
      : String(Number(requestedOpenLockDelayMs));
    delete environment.CLOSE_DEBOUNCE_MS;
    environment.WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = numberString(
      body,
      "signatureToleranceSeconds",
      300,
    );
    environment.PORT = numberString(body, "port", effectiveNumber(current.PORT, 8_080));
    // Preserve DRY_RUN as a headless safety override while the web UI exposes
    // one unambiguous automatic-relocking switch.
    environment.DRY_RUN = boolString(!Boolean(body.automationEnabled));

    return { environment, config: readConfig(environment) };
  }

  async save(body) {
    const { environment, config } = this.candidate(body);
    const record = {};
    for (const key of RUNTIME_KEYS) {
      if (environment[key] !== undefined && environment[key] !== "") record[key] = String(environment[key]);
    }

    const adminUsername = bodyString(body, "adminUsername", environment.ADMIN_USERNAME || "admin");
    if (!adminUsername) throw new Error("Admin username is required");
    record.ADMIN_USERNAME = adminUsername;

    const newPassword = typeof body.adminPassword === "string" ? body.adminPassword : "";
    const previousUsername = environment.ADMIN_USERNAME || "admin";
    if (adminUsername !== previousUsername && isAdminAuthenticationConfigured(environment) && !newPassword) {
      throw new Error("Enter a new administrator password when changing the username");
    }
    if (newPassword) {
      if (newPassword.length < 12) throw new Error("Admin password must be at least 12 characters");
      record.ADMIN_PASSWORD_HASH = hashPassword(newPassword);
    } else if (environment.ADMIN_PASSWORD_HASH) {
      record.ADMIN_PASSWORD_HASH = environment.ADMIN_PASSWORD_HASH;
    } else if (environment.ADMIN_PASSWORD) {
      record.ADMIN_PASSWORD_HASH = hashPassword(environment.ADMIN_PASSWORD);
    }

    await this.store.write(record);
    this.stored = record;
    return { config, settings: this.publicSettings() };
  }
}
