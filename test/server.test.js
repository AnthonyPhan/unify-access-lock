import assert from "node:assert/strict";
import test from "node:test";
import { isHomeAssistantIngressRequest } from "../src/server.js";

function request({ remoteAddress = "172.30.32.2", ingressPath = "/api/hassio_ingress/session-id/" } = {}) {
  return {
    socket: { remoteAddress },
    headers: { "x-ingress-path": ingressPath },
  };
}

test("recognizes a request from the Home Assistant ingress proxy", () => {
  assert.equal(
    isHomeAssistantIngressRequest(request(), { HOME_ASSISTANT_INGRESS: "true" }),
    true,
  );
});

test("does not trust an ingress header received from a LAN client", () => {
  assert.equal(
    isHomeAssistantIngressRequest(
      request({ remoteAddress: "192.168.1.20" }),
      { HOME_ASSISTANT_INGRESS: "true" },
    ),
    false,
  );
});

test("does not bypass authentication outside Home Assistant mode", () => {
  assert.equal(
    isHomeAssistantIngressRequest(request(), {}),
    false,
  );
});

test("accepts IPv4-mapped ingress proxy addresses", () => {
  assert.equal(
    isHomeAssistantIngressRequest(
      request({ remoteAddress: "::ffff:172.30.32.2" }),
      { HOME_ASSISTANT_INGRESS: "true" },
    ),
    true,
  );
});
