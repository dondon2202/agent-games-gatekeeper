// Field encodings: task-envelope values -> circom circuit inputs.
//
// The circuit input mapping was RECOVERED by black-box inspection of the
// public gatekeeper.wasm (see REPORT.md section "Circuit reverse engineering"
// and scripts/discover-inputs.js, probe-*.js). The VALUE ENCODINGS below are
// the natural mappings; the two marked ASSUMPTION are not verifiable from
// public sources and must be confirmed against platform behavior after
// registration (practice mode). Each encoding lives in exactly one function
// so a correction is a one-line change.

import { createHash, randomBytes } from "node:crypto";

// BN128 (alt_bn128) scalar field order: the field snarkjs works over for
// Groth16/BN128. All circuit inputs are elements of this field.
export const FIELD_PRIME =
  21888242871839275222246405745257275088614511777268538073601725287587578984328n;

const MAX_UINT160 = (1n << 160n) - 1n;

export class EncodingError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncodingError";
  }
}

/** Parse a non-negative integer supplied as a JSON string or safe number. */
export function toFieldInt(value, fieldName) {
  let v;
  if (typeof value === "bigint") {
    v = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new EncodingError(`${fieldName}: expected a non-negative safe integer, got ${value}`);
    }
    v = BigInt(value);
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    v = BigInt(value);
  } else {
    throw new EncodingError(`${fieldName}: expected a decimal integer string or safe number`);
  }
  if (v >= FIELD_PRIME) {
    throw new EncodingError(`${fieldName}: value exceeds the BN128 field prime`);
  }
  return v;
}

/**
 * VK hash encoding.
 * ASSUMPTION: the task's registered_vk / proof_vk values are hex hashes and
 * the circuit input is BigInt(hex) reduced mod p. Reduction is forced: a
 * random 32-byte hash exceeds the ~254-bit field prime ~75% of the time, so
 * the platform must reduce (or use sub-prime hashes) for the values to be
 * field elements at all. The circuit only checks equality of the two values,
 * so any deterministic encoding is circuit-correct; this encoding matters
 * only if the platform recomputes the expected public signals.
 */
export function vkHashToField(hex, fieldName) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new EncodingError(`${fieldName}: expected a 0x-prefixed hex string`);
  }
  return BigInt(hex) % FIELD_PRIME;
}

/** Ethereum-style address -> field element. Must fit in 160 bits. */
export function addressToField(hex, fieldName) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(hex)) {
    throw new EncodingError(`${fieldName}: expected a 0x-prefixed 20-byte hex address`);
  }
  const v = BigInt(hex);
  if (v > MAX_UINT160) throw new EncodingError(`${fieldName}: address exceeds 160 bits`);
  return v;
}

/**
 * task_id encoding.
 * ASSUMPTION (highest-risk): task_id is an opaque string ("gk_8d31_...").
 * Encoded as SHA-256(task_id) mod p. The circuit does not constrain taskId,
 * so this encoding affects only the public signals the platform reads; if the
 * platform recomputes the expected taskId field element with a different
 * function (e.g. keccak256), proofs will fail its cross-check. Swap this
 * function if registration/practice reveals the real encoding.
 */
export function taskIdToField(taskId) {
  if (typeof taskId !== "string" || taskId.length === 0) {
    throw new EncodingError("task_id: expected a non-empty string");
  }
  const digest = createHash("sha256").update(taskId, "utf8").digest();
  return BigInt("0x" + digest.toString("hex")) % FIELD_PRIME;
}

/** Fresh random private salt, uniform in [0, p). Never logged, never reused. */
export function randomSalt() {
  return BigInt("0x" + randomBytes(32).toString("hex")) % FIELD_PRIME;
}

/**
 * Build the full circom input object for one task + decision.
 * `checks` carries the already-validated task fields; `decision` is 1n
 * (APPROVE) or 0n (REJECT). Throws EncodingError on any malformed value.
 */
export function buildCircuitInput(checks, decision, salt) {
  return {
    registeredVkHash: vkHashToField(checks.registered_vk, "registered_vk").toString(),
    proofVkHash: vkHashToField(checks.proof_vk, "proof_vk").toString(),
    minimum: toFieldInt(checks.minimum, "minimum").toString(),
    publicBalance: toFieldInt(checks.public_balance, "public_balance").toString(),
    expiryBlock: toFieldInt(checks.expiry_block, "expiry_block").toString(),
    currentBlock: toFieldInt(checks.current_block, "current_block").toString(),
    recipient: addressToField(checks.recipient, "recipient").toString(),
    conditionRecipient: addressToField(checks.condition_recipient, "condition_recipient").toString(),
    amount: toFieldInt(checks.amount, "amount").toString(),
    maxTransfer: toFieldInt(checks.max_transfer, "max_transfer").toString(),
    decision: decision.toString(),
    taskId: taskIdToField(checks.task_id).toString(),
    salt: salt.toString(),
  };
}
