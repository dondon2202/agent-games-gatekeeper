// Probe 5: what is public signal #1 (witness index 1)? Vary one input at a
// time from a satisfying baseline and observe whether S0 (witness[1])
// changes. This reveals which inputs feed the computed first public signal.
// Usage: node scripts/probe-s0.js
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);

const base = {
  registeredVkHash: 1001n,
  proofVkHash: 1001n,
  minimum: 1000n,
  publicBalance: 1460n,
  expiryBlock: 8430000n,
  currentBlock: 8420000n,
  recipient: 0xde42n,
  conditionRecipient: 0xde42n,
  amount: 500n,
  maxTransfer: 2000n,
  decision: 1n,
  taskId: 4242n,
  salt: 777n,
};

async function s0(inp) {
  const w = await wc.calculateWitness(inp, false);
  return w[1];
}

const baseS0 = await s0(base);
console.log("baseline S0:", baseS0.toString());

const probes = [
  ["salt 777->778", { ...base, salt: 778n }],
  ["salt 777->0", { ...base, salt: 0n }],
  ["taskId 4242->4243", { ...base, taskId: 4243n }],
  ["taskId 4242->0", { ...base, taskId: 0n }],
  ["minimum 1000->1001 (still valid)", { ...base, minimum: 1001n }],
  ["publicBalance 1460->1461", { ...base, publicBalance: 1461n }],
  ["expiryBlock +1", { ...base, expiryBlock: 8430001n }],
  ["currentBlock +1", { ...base, currentBlock: 8420001n }],
  ["amount 500->501", { ...base, amount: 501n }],
  ["maxTransfer 2000->2001", { ...base, maxTransfer: 2001n }],
  ["vk pair 1001->1002", { ...base, registeredVkHash: 1002n, proofVkHash: 1002n }],
  ["recipient pair ->0xde43", { ...base, recipient: 0xde43n, conditionRecipient: 0xde43n }],
  // decision flip requires a trap: flip one check AND decision together
  ["trap (vk mismatch) + decision=0", { ...base, proofVkHash: 1002n, decision: 0n }],
];
for (const [label, inp] of probes) {
  try {
    const v = await s0(inp);
    console.log(`${v === baseS0 ? "SAME  " : "CHANGED"} ${label} -> ${v === baseS0 ? "(unchanged)" : v.toString().slice(0, 40) + "..."}`);
  } catch {
    console.log(`[FAIL] ${label} (assignment unsatisfying)`);
  }
}
