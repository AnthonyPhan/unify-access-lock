function required(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function boolean(environment, key, fallback) {
  const value = environment[key];
  if (value === undefined || value === "") return fallback;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${key} must be true or false`);
}

function positiveInteger(environment, key, fallback) {
  const raw = environment[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(environment, key, fallback) {
  const raw = environment[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function accessUrl(raw) {
  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  if (!url.port) url.port = "12445";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function csvSet(raw = "") {
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

export function readConfig(environment = process.env) {
  const autoRegisterWebhook = boolean(environment, "AUTO_REGISTER_WEBHOOK", true);
  const webhookPublicUrl = environment.WEBHOOK_PUBLIC_URL?.trim() || undefined;
  const webhookSecret = environment.WEBHOOK_SECRET?.trim() || undefined;

  if (autoRegisterWebhook && !webhookPublicUrl) {
    throw new Error("WEBHOOK_PUBLIC_URL is required when AUTO_REGISTER_WEBHOOK=true");
  }
  if (!autoRegisterWebhook && !webhookSecret) {
    throw new Error("WEBHOOK_SECRET is required when AUTO_REGISTER_WEBHOOK=false");
  }

  if (webhookPublicUrl) {
    const protocol = new URL(webhookPublicUrl).protocol;
    if (protocol !== "http:" && protocol !== "https:") {
      throw new Error("WEBHOOK_PUBLIC_URL must use http or https");
    }
  }

  const webhookPath = environment.WEBHOOK_PATH?.trim() || "/webhooks/unifi";
  if (!webhookPath.startsWith("/")) throw new Error("WEBHOOK_PATH must start with /");

  const port = positiveInteger(environment, "PORT", 8_080);
  if (port > 65_535) throw new Error("PORT must be between 1 and 65535");
  const dryRun = boolean(environment, "DRY_RUN", false);
  const automationRequested = boolean(environment, "AUTOMATIC_DPS_RELOCK_ENABLED", false);
  const nativeTriggerMs = positiveInteger(environment, "NATIVE_TRIGGER_MS", 1_000);
  if (automationRequested && !dryRun && nativeTriggerMs < 1_000) {
    throw new Error("NATIVE_TRIGGER_MS must be at least 1000 when automatic DPS relocking is enabled");
  }

  return {
    unifi: {
      baseUrl: accessUrl(required(environment, "UNIFI_ACCESS_URL")),
      token: required(environment, "UNIFI_API_TOKEN"),
      rejectUnauthorized: boolean(environment, "UNIFI_TLS_REJECT_UNAUTHORIZED", true),
      timeoutMs: positiveInteger(environment, "UNIFI_REQUEST_TIMEOUT_MS", 5_000),
    },
    server: {
      port,
      webhookPath,
      signatureToleranceSeconds: positiveInteger(
        environment,
        "WEBHOOK_SIGNATURE_TOLERANCE_SECONDS",
        300,
      ),
    },
    webhook: {
      autoRegister: autoRegisterWebhook,
      publicUrl: webhookPublicUrl,
      name: environment.WEBHOOK_NAME?.trim() || "unifi-access-lock",
      secret: webhookSecret,
    },
    doors: {
      ids: csvSet(environment.DOOR_IDS),
      lockTimeoutMs: positiveInteger(environment, "LOCK_TIMEOUT_MS", 60_000),
      nativeTriggerMs,
      openLockDelayMs: nonNegativeInteger(
        environment,
        "OPEN_LOCK_DELAY_MS",
        environment.CLOSE_DEBOUNCE_MS === undefined
          ? 0
          : positiveInteger(environment, "CLOSE_DEBOUNCE_MS", 250),
      ),
      automationEnabled: automationRequested && !dryRun,
      dryRun,
    },
  };
}
