// Probe 4: (a) can REJECT decisions be proven? Try each trap variety with
// decision=0. (b) Witness layout with a satisfying assignment: locate each
// input value to determine the public-signal order and public/private split.
// Usage: node scripts/probe-reject.js
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);

async function attempt(label, inp) {
  try {
    const w = await wc.calculateWitness(inp, false);
    console.log(`[OK]   ${label}`);
    return w;
  } catch {
    console.log(`[FAIL] ${label}`);
    return null;
  }
}

const valid = {
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

console.log("--- (a) trap inputs + decision=0: is a REJECT provable? ---");
await attempt("vk mismatch + decision=0", { ...valid, proofVkHash: 1002n, decision: 0n });
await attempt("balance trap + decision=0", { ...valid, publicBalance: 999n, decision: 0n });
await attempt("expired + decision=0", { ...valid, currentBlock: 8430001n, decision: 0n });
await attempt("recipient trap + decision=0", { ...valid, conditionRecipient: 0xde43n, decision: 0n });
await attempt("amount trap + decision=0", { ...valid, amount: 2001n, decision: 0n });
await attempt("valid + decision=0 (control, expect FAIL)", { ...valid, decision: 0n });
await attempt("vk mismatch + decision=2", { ...valid, proofVkHash: 1002n, decision: 2n });

console.log("\n--- (b) witness layout for a satisfying assignment ---");
const w = await attempt("valid distinct-value assignment", valid);
if (w) {
  console.log("witness[0..13]:", w.slice(0, 14).map(String).join(", "));
  for (const [name, val] of Object.entries(valid)) {
    const idxs = [];
    for (let i = 0; i < w.length; i++) if (w[i] === val) idxs.push(i);
    console.log(`  ${name} (${val}) at indices: ${idxs.join(", ")}`);
  }
}
