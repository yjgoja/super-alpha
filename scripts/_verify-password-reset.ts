/**
 * Offline checks for password-reset helpers (no email send, no DB write).
 */
import assert from "assert";
import {
  createPasswordResetToken,
  hashVerifyToken,
} from "../src/lib/mail";

function main() {
  const a = createPasswordResetToken();
  assert.ok(a.token.length >= 40, "token length");
  assert.equal(hashVerifyToken(a.token), a.tokenHash, "hash matches");
  assert.ok(a.expiresAt.getTime() > Date.now(), "expires in future");
  assert.ok(
    a.expiresAt.getTime() - Date.now() <= 60 * 60 * 1000 + 5000,
    "ttl ~1h",
  );
  assert.notEqual(
    hashVerifyToken(a.token),
    hashVerifyToken(a.token + "x"),
    "hash differs",
  );
  console.log("password-reset helpers OK");
}

main();
