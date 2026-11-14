// Unit tests: encodings + HMAC helpers.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  FIELD_PRIME, toFieldInt, vkHashToField, addressToField, taskIdToField,
  randomSalt, buildCircuitInput, EncodingError,
} from "../src/encoding.js";
import { verifySignature, signBody } from "../src/hmac.js";

test("toFieldInt accepts strings, numbers, bigints; rejects bad values", () => {
  assert.equal(toFieldInt("123", "f"), 123n);
  assert.equal(toFieldInt(123, "f"), 123n);
  assert.equal(toFieldInt(123n, "f"), 123n);
  assert.throws(() => toFieldInt("-1", "f"), EncodingError);
  assert.throws(() => toFieldInt("1.5", "f"), EncodingError);
  assert.throws(() => toFieldInt(1.5, "f"), EncodingError);
  assert.throws(() => toFieldInt(FIELD_PRIME, "f"), EncodingError);
  assert.throws(() => toFieldInt("0x10", "f"), EncodingError);
});

test("vkHashToField reduces mod p (32-byte hashes may exceed the prime)", () => {
  const big = "0x" + "ff".repeat(32);
  const v = vkHashToField(big, "vk");
  assert.ok(v < FIELD_PRIME);
  assert.equal(v, BigInt(big) % FIELD_PRIME);
  assert.equal(vkHashToField("0x10", "vk"), 16n);
  assert.throws(() => vkHashToField("10", "vk"), EncodingError);
  assert.throws(() => vkHashToField("0xzz", "vk"), EncodingError);
});

test("addressToField requires a 20-byte address", () => {
  assert.equal(addressToField("0x" + "ab".repeat(20), "a"), BigInt("0x" + "ab".repeat(20)));
  assert.throws(() => addressToField("0x1234", "a"), EncodingError);
  assert.throws(() => addressToField("ab".repeat(20), "a"), EncodingError);
});

test("taskIdToField is deterministic and field-sized", () => {
  const a = taskIdToField("gk_8d31_test");
  assert.equal(a, taskIdToField("gk_8d31_test"));
  assert.notEqual(a, taskIdToField("gk_8d31_other"));
  assert.ok(a < FIELD_PRIME);
  assert.throws(() => taskIdToField(""), EncodingError);
});

test("randomSalt is uniform-ish, field-sized, and varies", () => {
  const a = randomSalt();
  const b = randomSalt();
  assert.ok(a < FIELD_PRIME && b < FIELD_PRIME);
  assert.notEqual(a, b);
});

test("buildCircuitInput produces all 13 named signals as decimal strings", () => {
  const input = buildCircuitInput({
    task_id: "gk_1",
    registered_vk: "0x" + "11".repeat(32),
    proof_vk: "0x" + "11".repeat(32),
    minimum: "1000", public_balance: "1460",
    expiry_block: 8430000, current_block: 8420000,
    recipient: "0x" + "22".repeat(20),
    condition_recipient: "0x" + "22".repeat(20),
    amount: "500", max_transfer: "1000",
  }, 1n, 777n);
  assert.deepEqual(Object.keys(input).sort(), [
    "amount", "conditionRecipient", "currentBlock", "decision", "expiryBlock",
    "maxTransfer", "minimum", "proofVkHash", "publicBalance", "recipient",
    "registeredVkHash", "salt", "taskId",
  ].sort());
  assert.equal(input.decision, "1");
  assert.equal(input.salt, "777");
  for (const v of Object.values(input)) assert.match(v, /^\d+$/);
});

test("HMAC: hex and base64 signatures verify; tampering fails", () => {
  const secret = "test-secret-32-bytes-long-value!";
  const body = Buffer.from('{"type":"x"}', "utf8");
  const digest = createHmac("sha256", secret).update(body).digest();
  assert.equal(verifySignature(secret, body, digest.toString("hex")), true);
  assert.equal(verifySignature(secret, body, digest.toString("hex").toUpperCase()), true);
  assert.equal(verifySignature(secret, body, digest.toString("base64")), true);
  assert.equal(verifySignature(secret, Buffer.from('{"type":"y"}', "utf8"), digest.toString("hex")), false);
  assert.equal(verifySignature("wrong-secret", body, digest.toString("hex")), false);
  assert.equal(verifySignature(secret, body, "00".repeat(32)), false);
  assert.equal(verifySignature(secret, body, ""), false);
  assert.equal(verifySignature(secret, body, undefined), false);
  assert.equal(verifySignature(secret, body, "not-a-signature"), false);
  assert.equal(verifySignature("", body, digest.toString("hex")), false);
});

test("HMAC: signBody output verifies", () => {
  const secret = "s3cr3t";
  const body = Buffer.from("hello", "utf8");
  assert.equal(verifySignature(secret, body, signBody(secret, body)), true);
});
