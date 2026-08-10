import http from "node:http";
import https from "node:https";

export class UnifiApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "UnifiApiError";
    Object.assign(this, details);
  }
}

function sameEvents(left = [], right = []) {
  return [...left].sort().join("\0") === [...right].sort().join("\0");
}

export class UnifiAccessClient {
  constructor({ baseUrl, token, rejectUnauthorized = true, timeoutMs = 5_000 }) {
    this.baseUrl = new URL(baseUrl);
    this.token = token;
    this.rejectUnauthorized = rejectUnauthorized;
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, body) {
    const url = new URL(path, this.baseUrl);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const transport = url.protocol === "https:" ? https : http;

    const response = await new Promise((resolve, reject) => {
      const request = transport.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            accept: "application/json",
            ...(payload
              ? {
                  "content-type": "application/json",
                  "content-length": payload.length,
                }
              : {}),
          },
          rejectUnauthorized: this.rejectUnauthorized,
        },
        (incoming) => {
          const chunks = [];
          let size = 0;

          incoming.on("data", (chunk) => {
            size += chunk.length;
            if (size > 5 * 1024 * 1024) {
              incoming.destroy(new Error("UniFi API response exceeded 5 MiB"));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on("end", () => {
            resolve({
              statusCode: incoming.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            });
          });
          incoming.on("error", reject);
        },
      );

      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error(`UniFi API request timed out after ${this.timeoutMs}ms`));
      });
      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });

    let parsed;
    try {
      parsed = response.text ? JSON.parse(response.text) : undefined;
    } catch {
      throw new UnifiApiError("UniFi API returned invalid JSON", {
        method,
        path,
        statusCode: response.statusCode,
      });
    }

    if (response.statusCode < 200 || response.statusCode >= 300 || parsed?.code !== "SUCCESS") {
      throw new UnifiApiError(parsed?.msg || `UniFi API request failed (${response.statusCode})`, {
        method,
        path,
        statusCode: response.statusCode,
        code: parsed?.code,
      });
    }

    return parsed.data;
  }

  listDoors() {
    return this.request("GET", "/api/v1/developer/doors");
  }

  getDoor(doorId) {
    return this.request("GET", `/api/v1/developer/doors/${encodeURIComponent(doorId)}`);
  }

  getLockRule(doorId) {
    return this.request("GET", `/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`);
  }

  setLockRule(doorId, type, interval) {
    return this.request("PUT", `/api/v1/developer/doors/${encodeURIComponent(doorId)}/lock_rule`, {
      type,
      ...(interval === undefined ? {} : { interval }),
    });
  }

  lockNow(doorId) {
    return this.setLockRule(doorId, "lock_now");
  }

  lockEarly(doorId) {
    return this.setLockRule(doorId, "lock_early");
  }

  resetLockRule(doorId) {
    return this.setLockRule(doorId, "reset");
  }

  customUnlock(doorId, intervalMinutes = 1) {
    return this.setLockRule(doorId, "custom", intervalMinutes);
  }

  unlockDoor(doorId) {
    return this.request("PUT", `/api/v1/developer/doors/${encodeURIComponent(doorId)}/unlock`);
  }

  getEmergencyStatus() {
    return this.request("GET", "/api/v1/developer/doors/settings/emergency");
  }

  listWebhooks() {
    return this.request("GET", "/api/v1/developer/webhooks/endpoints");
  }

  async ensureWebhook({ name, endpoint, events }) {
    const endpoints = (await this.listWebhooks()) ?? [];
    const existing = endpoints.find((candidate) => candidate.name === name);
    let configured = existing;

    if (!existing) {
      configured = await this.request("POST", "/api/v1/developer/webhooks/endpoints", {
        name,
        endpoint,
        events,
      });
    } else if (existing.endpoint !== endpoint || !sameEvents(existing.events, events)) {
      configured = await this.request(
        "PUT",
        `/api/v1/developer/webhooks/endpoints/${encodeURIComponent(existing.id)}`,
        { name, endpoint, events },
      );
    }

    if (!configured?.secret) {
      const refreshed = (await this.listWebhooks()) ?? [];
      configured = refreshed.find((candidate) => candidate.name === name);
    }

    if (!configured?.secret) {
      throw new UnifiApiError(`UniFi did not return a secret for webhook ${name}`);
    }

    return configured;
  }
}
