import { createHmac, timingSafeEqual } from "node:crypto";

export class WebhookSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

function parseSignatureHeader(header) {
  if (!header) throw new WebhookSignatureError("Webhook has no Signature header");

  const values = new Map();
  for (const pair of header.split(",")) {
    const separator = pair.indexOf("=");
    if (separator < 1) throw new WebhookSignatureError("Webhook has an invalid Signature header");
    values.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }

  const timestamp = Number(values.get("t"));
  const signatureHex = values.get("v1");
  if (!Number.isSafeInteger(timestamp) || !/^[a-f\d]{64}$/i.test(signatureHex ?? "")) {
    throw new WebhookSignatureError("Webhook has an invalid Signature header");
  }

  return { timestamp, signature: Buffer.from(signatureHex, "hex") };
}

export function verifyWebhookSignature({
  payload,
  signatureHeader,
  secret,
  toleranceSeconds = 300,
  nowMs = Date.now(),
}) {
  const { timestamp, signature } = parseSignatureHeader(signatureHeader);
  if (Math.abs(nowMs / 1_000 - timestamp) > toleranceSeconds) {
    throw new WebhookSignatureError("Webhook signature timestamp is outside the allowed tolerance");
  }

  const expected = createHmac("sha256", secret)
    .update(String(timestamp))
    .update(".")
    .update(payload)
    .digest();

  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
    throw new WebhookSignatureError("Webhook signature does not match");
  }

  return true;
}
