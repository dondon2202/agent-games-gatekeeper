// Discovery probe: brute-force circom input signal names against the gatekeeper
// wasm via its FNV-hash lookup (getInputSignalSize). Read-only, local only.
// The wasm exposes getInputSignalSize(hMSB, hLSB) which returns >= 0 when the
// FNV-1a 64 hash matches a real input signal. This script tests a dictionary
// of plausible names and reports every hit with its signal size.
// Usage: node scripts/discover-inputs.js
// Requires: circom_runtime (transitive dep of snarkjs, already installed).
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt("0xCBF29CE484222325");
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash *= BigInt("0x100000001B3");
    hash %= uint64_max;
  }
  return hash.toString(16).padStart(16, "0");
}

const BASES = [
  "registered_vk", "proof_vk", "minimum", "public_balance", "balance",
  "expiry_block", "current_block", "recipient", "condition_recipient",
  "amount", "max_transfer", "proof_tx", "vk", "threshold", "decision",
  "valid", "approved", "hash", "commitment", "nonce", "task_id", "salt",
  "nullifier", "seen", "reused", "is_reused", "public_inputs_hash",
  "inputs_hash", "action", "transfer", "value", "sender", "owner", "chain",
  "block", "deadline", "timestamp", "signature", "sig", "pubkey", "address",
  "token", "id", "vk_hash", "proof_hash", "tx_hash", "tx", "ref", "proof_ref",
  "proof_reference", "expected_recipient", "expected_vk", "registered",
  "proof", "public", "private", "input", "output", "result", "is_valid",
  "is_approved", "allow", "allowed", "check", "gate", "condition", "policy",
  "min", "max", "limit", "cap", "from", "to", "dest", "destination",
  "source", "account", "user", "agent", "event", "round", "match", "game",
  "score", "state", "root", "leaf", "proof_system", "circuit", "version",
  "domain", "separator", "challenge", "randomness", "secret", "key",
  "public_key", "verification_key", "vk_registered", "registered_vk_hash",
  "proof_vk_hash", "balance_minimum", "min_balance", "required", "required_minimum",
  "expiry", "expiration", "expires", "current", "now", "height", "block_number",
  "block_height", "amount_max", "max_amount", "transfer_amount", "transfer_max",
  "proof_tx_hash", "reference", "tx_ref", "seen_proof", "already_seen",
  "is_seen", "used", "is_used", "consumed", "spent", "flag", "flags",
  "enabled", "ok", "success", "pass", "passed", "assert", "asserted",
];

function variants(base) {
  const parts = base.split("_");
  const camel = parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  const pascal = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  const upper = base.toUpperCase();
  const joined = parts.join("");
  const out = new Set([base, camel, pascal, upper, joined]);
  // common prefixes / suffixes
  for (const pre of ["in_", "pub_", "public_", "priv_", "private_", "in", "pub"]) {
    out.add(pre + base);
    out.add(pre + camel);
  }
  for (const suf of ["_hash", "Hash", "_value", "Value", "_in", "_input", "Input"]) {
    out.add(base + suf);
    out.add(camel + suf);
  }
  return [...out];
}

const candidates = new Set();
for (const b of BASES) for (const v of variants(b)) candidates.add(v);
// also single letters and short generic names circom examples use
for (const s of ["a", "b", "c", "d", "e", "x", "y", "z", "in", "out", "inp", "in0", "in1", "in2", "s", "v", "h", "k", "n", "m", "t", "r", "p", "q", "w"]) candidates.add(s);

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);
console.log("circom version:", wc.circom_version());
console.log("witness size:", wc.witnessSize);
console.log("total input values (getInputSize):", wc.instance.exports.getInputSize());
console.log("candidates:", candidates.size);

const hits = [];
for (const name of candidates) {
  const h = fnvHash(name);
  const hMSB = parseInt(h.slice(0, 8), 16);
  const hLSB = parseInt(h.slice(8, 16), 16);
  try {
    const size = wc.instance.exports.getInputSignalSize(hMSB, hLSB);
    if (typeof size === "number" && size >= 0) {
      hits.push({ name, size });
      console.log("HIT:", name, "size", size);
    }
  } catch {
    // unknown signal: wasm trap -> not a real input name
  }
}
console.log("\nTotal hits:", hits.length, "sum of sizes:", hits.reduce((a, h) => a + h.size, 0));
