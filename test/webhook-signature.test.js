import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { verifyWebhookSignature, WebhookSignatureError } from "../src/webhook-signature.js";

function signature(secret, timestamp, payload) {
  const digest = createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(payload)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

test("accepts a valid UniFi webhook signature", () => {
  const timestamp = 1_700_000_000;
  const payload = Buffer.from('{"event":"access.door.unlock"}');
  assert.equal(
    verifyWebhookSignature({
      payload,
      signatureHeader: signature("secret", timestamp, payload),
      secret: "secret",
      nowMs: timestamp * 1_000,
    }),
    true,
  );
});

test("rejects a mismatched signature", () => {
  const timestamp = 1_700_000_000;
  const payload = Buffer.from("{}");
  assert.throws(
    () =>
      verifyWebhookSignature({
        payload,
        signatureHeader: signature("wrong", timestamp, payload),
        secret: "secret",
        nowMs: timestamp * 1_000,
      }),
    WebhookSignatureError,
  );
});

test("rejects a replay outside the timestamp tolerance", () => {
  const timestamp = 1_700_000_000;
  const payload = Buffer.from("{}");
  assert.throws(
    () =>
      verifyWebhookSignature({
        payload,
        signatureHeader: signature("secret", timestamp, payload),
        secret: "secret",
        toleranceSeconds: 300,
        nowMs: (timestamp + 301) * 1_000,
      }),
    /outside the allowed tolerance/,
  );
});
