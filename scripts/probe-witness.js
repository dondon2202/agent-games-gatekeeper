// Probe 2: witness-layout inspection. Sets every discovered input signal to a
// distinct value, computes the witness, and locates each value in the witness
// array. Witness layout in circom: [1, public signals (nPublic), private
// inputs..., aux signals...]. This reveals the public/private split and the
// public-signal order. Read-only, local only.
// Usage: node scripts/probe-witness.js
import fs from "node:fs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const wasm = fs.readFileSync(new URL("../circuits/gatekeeper.wasm", import.meta.url));
const wc = await WitnessCalculatorBuilder(wasm);

const input = {
  registeredVkHash: 101n,
  proofVkHash: 102n,
  minimum: 103n,
  publicBalance: 104n,
  expiryBlock: 105n,
  currentBlock: 106n,
  recipient: 107n,
  conditionRecipient: 108n,
  amount: 109n,
  maxTransfer: 110n,
  decision: 111n,
  taskId: 112n,
  salt: 113n,
};

async function attempt(label, inp, sanityCheck) {
  try {
    const w = await wc.calculateWitness(inp, sanityCheck);
    console.log(`\n[${label}] witness computed, length ${w.length}`);
    console.log("witness[0..15]:", w.slice(0, 16).map(String).join(", "));
    for (const [name, val] of Object.entries(inp)) {
      const idxs = [];
      for (let i = 0; i < w.length; i++) if (w[i] === val) idxs.push(i);
      console.log(`  ${name} (${val}) found at witness indices: ${idxs.join(", ") || "(none)"}`);
    }
    return w;
  } catch (e) {
    console.log(`\n[${label}] FAILED: ${String(e.message || e).slice(0, 500)}`);
    return null;
  }
}

// Distinct values, no sanity check: pure layout inspection.
await attempt("distinct-values, sanityCheck=false", input, false);
