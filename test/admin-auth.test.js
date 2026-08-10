import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, isAdminAuthenticationConfigured, verifyBasicAuthorization } from "../src/admin-auth.js";

function authorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

test("accepts the configured administrator credentials", () => {
  const environment = {
    ADMIN_USERNAME: "operator",
    ADMIN_PASSWORD_HASH: hashPassword("a-long-test-password"),
  };
  assert.equal(isAdminAuthenticationConfigured(environment), true);
  assert.equal(
    verifyBasicAuthorization(authorization("operator", "a-long-test-password"), environment),
    true,
  );
});

test("rejects incorrect administrator credentials", () => {
  const environment = {
    ADMIN_USERNAME: "operator",
    ADMIN_PASSWORD_HASH: hashPassword("a-long-test-password"),
  };
  assert.equal(verifyBasicAuthorization(authorization("operator", "wrong-password"), environment), false);
  assert.equal(verifyBasicAuthorization(undefined, environment), false);
});

test("allows initial setup when no administrator password exists", () => {
  assert.equal(verifyBasicAuthorization(undefined, {}), true);
});
