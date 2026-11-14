// Verification probe: re-derives public signal #1 (witness index 1) from the
// wasm for a known (taskId, salt) pair and checks it equals
// circomlibjs Poseidon([salt, taskId]). Confirms the binding commitment
// formula S0 = Poseidon(salt, taskId). Read-only, local only.
// Usage: node scripts/probe-poseidon.js
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";
import { buildPoseidon } from "circomlibjs";

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);
const poseidon = await buildPoseidon();
const F = poseidon.F;

const input = {
  registeredVkHash: 1001n, proofVkHash: 1001n,
  minimum: 1000n, publicBalance: 1460n,
  expiryBlock: 8430000n, currentBlock: 8420000n,
  recipient: 0xde42n, conditionRecipient: 0xde42n,
  amount: 500n, maxTransfer: 2000n,
  decision: 1n, taskId: 4242n, salt: 777n,
};
const w = await wc.calculateWitness(input, false);
const s0 = w[1];
const expected = F.toObject(poseidon([input.salt, input.taskId]));
console.log("witness[1] (S0):          ", s0.toString());
console.log("Poseidon([salt, taskId]): ", expected.toString());
console.log(expected === s0 ? "MATCH: S0 = Poseidon(salt, taskId)" : "MISMATCH");
process.exit(expected === s0 ? 0 : 1);
