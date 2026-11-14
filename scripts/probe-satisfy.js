// Probe 3: satisfiability search. Tries candidate assignments against the
// witness calculator and reports which template line (if any) asserts.
// The wasm checks assertions during witness computation, so each failure
// pinpoints a constraint. Read-only, local only.
// Usage: node scripts/probe-satisfy.js
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);

async function attempt(label, inp) {
  try {
    const w = await wc.calculateWitness(inp, false);
    console.log(`[OK]   ${label} (witness len ${w.length})`);
    return w;
  } catch (e) {
    const m = String(e.message || e).replace(/\n+/g, " ").slice(0, 200);
    console.log(`[FAIL] ${label} -> ${m}`);
    return null;
  }
}

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
  maxTransfer: 1000n,
  decision: 1n,
  taskId: 4242n,
  salt: 777n,
};

await attempt("all-checks-pass, decision=1", base);
await attempt("all-checks-pass, decision=0", { ...base, decision: 0n });
await attempt("all-checks-pass, decision=2", { ...base, decision: 2n });
// Single-violation probes (decision=1): which violation trips which line?
await attempt("vk mismatch", { ...base, proofVkHash: 1002n });
await attempt("balance below minimum", { ...base, publicBalance: 999n });
await attempt("expired", { ...base, currentBlock: 8430001n });
await attempt("recipient mismatch", { ...base, conditionRecipient: 0xde43n });
await attempt("amount overflow", { ...base, amount: 1001n });
// Boundary probes
await attempt("balance == minimum", { ...base, publicBalance: 1000n });
await attempt("current == expiry", { ...base, currentBlock: 8430000n });
await attempt("amount == maxTransfer", { ...base, amount: 1000n });
await attempt("salt=0", { ...base, salt: 0n });
await attempt("taskId=0", { ...base, taskId: 0n });
