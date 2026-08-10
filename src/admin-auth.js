import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${digest.toString("hex")}`;
}

function verifyPassword(password, encodedHash) {
  const [algorithm, saltHex, digestHex] = encodedHash.split("$");
  if (algorithm !== "scrypt" || !/^[a-f\d]{32}$/i.test(saltHex ?? "")) return false;
  if (!/^[a-f\d]{64}$/i.test(digestHex ?? "")) return false;

  const expected = Buffer.from(digestHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function isAdminAuthenticationConfigured(environment) {
  return Boolean(environment.ADMIN_PASSWORD_HASH || environment.ADMIN_PASSWORD);
}

export function verifyBasicAuthorization(header, environment) {
  if (!isAdminAuthenticationConfigured(environment)) return true;
  if (!header?.startsWith("Basic ")) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const expectedUsername = environment.ADMIN_USERNAME || "admin";

  const usernameMatches = safeEqual(username, expectedUsername);
  const passwordMatches = environment.ADMIN_PASSWORD_HASH
    ? verifyPassword(password, environment.ADMIN_PASSWORD_HASH)
    : safeEqual(password, environment.ADMIN_PASSWORD || "");
  return usernameMatches && passwordMatches;
}
