import http from "node:http";
import { readFile } from "node:fs/promises";
import { verifyBasicAuthorization } from "./admin-auth.js";
import { EventDeduplicator } from "./event-deduplicator.js";
import { verifyWebhookSignature, WebhookSignatureError } from "./webhook-signature.js";

const MAX_BODY_BYTES = 1024 * 1024;
const STATIC_FILES = new Map([
  ["/", { file: new URL("../public/index.html", import.meta.url), type: "text/html; charset=utf-8" }],
  ["/app.js", { file: new URL("../public/app.js", import.meta.url), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { file: new URL("../public/styles.css", import.meta.url), type: "text/css; charset=utf-8" }],
]);

function secureHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

function json(response, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...secureHeaders("application/json; charset=utf-8"),
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const payload = await readBody(request);
  const parsed = JSON.parse(payload.toString("utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Request body must be a JSON object");
  }
  return parsed;
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function authenticate(request, response, configManager) {
  const environment = configManager.environment();
  if (verifyBasicAuthorization(request.headers.authorization, environment)) return true;

  json(
    response,
    401,
    { error: "Administrator sign-in required" },
    { "www-authenticate": 'Basic realm="UniFi Access Lock", charset="UTF-8"' },
  );
  return false;
}

async function serveStatic(pathname, response) {
  const asset = STATIC_FILES.get(pathname);
  if (!asset) return false;
  const payload = await readFile(asset.file);
  response.writeHead(200, {
    ...secureHeaders(asset.type),
    "content-length": payload.length,
  });
  response.end(payload);
  return true;
}

async function handleWebhook({
  request,
  response,
  context,
  signatureToleranceSeconds,
  runtime,
  logger,
  deduplicator,
}) {
  try {
    const payload = await readBody(request);
    verifyWebhookSignature({
      payload,
      signatureHeader: request.headers.signature,
      secret: context.secret,
      toleranceSeconds: signatureToleranceSeconds,
    });

    const event = JSON.parse(payload.toString("utf8"));
    if (!event || typeof event.event !== "string") throw new Error("Webhook payload has no event name");
    runtime.recordWebhookDelivery(event);
    json(response, 200, { code: "SUCCESS", data: null, msg: "success" });
    if (!deduplicator.isDuplicate(event.event_object_id)) {
      setImmediate(() => void context.controller.handle(event));
    }
  } catch (error) {
    const statusCode = error instanceof WebhookSignatureError ? 401 : 400;
    logger.warn("Rejected webhook request", { statusCode, error: error.message });
    if (!response.headersSent) json(response, statusCode, { error: error.message });
  }
}

export function createServer({
  configManager,
  runtime,
  actualPort,
  logger,
  deduplicator = new EventDeduplicator(),
}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    try {
      const webhook = runtime.webhookContext(url.pathname);
      if (request.method === "POST" && webhook) {
        if (!webhook.ready) {
          json(response, 503, { error: "Automation is not ready" });
          return;
        }
        const { config } = configManager.tryConfig();
        await handleWebhook({
          request,
          response,
          context: webhook,
          signatureToleranceSeconds: config?.server.signatureToleranceSeconds ?? 300,
          runtime,
          logger,
          deduplicator,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        const status = runtime.snapshot();
        json(response, status.phase === "ready" ? 200 : 503, {
          status: status.phase,
          message: status.message,
          armedDoors: status.armedDoors.length,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/config") {
        if (!authenticate(request, response, configManager)) return;
        const { error } = configManager.tryConfig();
        json(response, 200, {
          settings: configManager.publicSettings(),
          runtime: runtime.snapshot(),
          actualPort,
          configurationError: error,
          authenticationConfigured: configManager.authenticationConfigured(),
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        if (!authenticate(request, response, configManager)) return;
        const sinceValue = url.searchParams.get("since");
        if (sinceValue === null) {
          json(response, 200, { runtime: runtime.snapshot() });
          return;
        }

        const since = Number(sinceValue);
        if (!Number.isSafeInteger(since) || since < 0) {
          json(response, 400, { error: "Status revision must be a non-negative integer" });
          return;
        }

        json(response, 200, { runtime: await runtime.waitForStatusChange(since) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/test-connection") {
        if (!authenticate(request, response, configManager)) return;
        if (!originAllowed(request)) {
          json(response, 403, { error: "Request origin is not allowed" });
          return;
        }
        const body = await readJson(request);
        const { config } = configManager.candidate(body);
        const result = await runtime.test(config);
        json(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/lock-test") {
        if (!authenticate(request, response, configManager)) return;
        if (!originAllowed(request)) {
          json(response, 403, { error: "Request origin is not allowed" });
          return;
        }
        const body = await readJson(request);
        const doorId = typeof body.doorId === "string" ? body.doorId.trim() : "";
        const command = typeof body.command === "string" ? body.command.trim() : "unlock";
        if (!doorId) {
          json(response, 400, { error: "Select a door to test" });
          return;
        }
        json(response, 200, await runtime.testDoorCommand(doorId, command));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/webhook-test") {
        if (!authenticate(request, response, configManager)) return;
        if (!originAllowed(request)) {
          json(response, 403, { error: "Request origin is not allowed" });
          return;
        }
        json(response, 200, await runtime.startWebhookTest());
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/webhook-test/")) {
        if (!authenticate(request, response, configManager)) return;
        const testId = decodeURIComponent(url.pathname.slice("/api/webhook-test/".length));
        if (!testId || testId.includes("/")) {
          json(response, 400, { error: "Invalid webhook test ID" });
          return;
        }
        json(response, 200, runtime.webhookTest(testId));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/config") {
        if (!authenticate(request, response, configManager)) return;
        if (!originAllowed(request)) {
          json(response, 403, { error: "Request origin is not allowed" });
          return;
        }
        const body = await readJson(request);
        const { config, settings } = await configManager.save(body);
        const restartRequired = config.server.port !== actualPort;

        if (restartRequired) {
          runtime.markRestartRequired(
            `Saved. Restart the service to change its listening port from ${actualPort} to ${config.server.port}.`,
          );
        } else {
          setImmediate(() => void runtime.configure(config));
        }

        json(response, 200, {
          settings,
          restartRequired,
          actualPort,
          message: restartRequired ? runtime.snapshot().message : "Saved. Applying configuration now.",
        });
        return;
      }

      if (request.method === "GET" && (await serveStatic(url.pathname, response))) return;
      json(response, 404, { error: "not found" });
    } catch (error) {
      logger.warn("Web request failed", { method: request.method, path: url.pathname, error: error.message });
      if (!response.headersSent) json(response, 400, { error: error.message });
    }
  });
}
