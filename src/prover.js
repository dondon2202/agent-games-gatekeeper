// Groth16 prover: snarkjs fullProve over the gatekeeper circuit.
//
// Circuit interface (recovered from the public wasm, see REPORT.md):
//   inputs (13): registeredVkHash, proofVkHash, minimum, publicBalance,
//     expiryBlock, currentBlock, recipient, conditionRecipient, amount,
//     maxTransfer, decision, taskId (all public), salt (private).
//   public signals (13, in order): Poseidon(salt, taskId), then the 12
//     public inputs in declaration order.
//   constraints: decision == 1 iff (vk hashes equal AND balance >= minimum
//     AND currentBlock < expiryBlock AND recipients equal AND amount <=
//     maxTransfer); decision is boolean.
// The prover NEVER fabricates a proof: on any failure it throws
// ProofUnavailableError and the caller omits the proof fields (the decision
// is still returned; a missing proof costs -2, a fake proof would be worse
// and is impossible to produce anyway).
//
// Measured locally (2026-11-14, this VM): first fullProve ~4.2s (includes
// zkey/wasm load), steady-state ~1.2s, verify ~0.3s. Well inside the 60s
// platform deadline; the caller still enforces a hard budget.

import * as snarkjs from "snarkjs";
import { buildCircuitInput, randomSalt, EncodingError } from "./encoding.js";

export class ProofUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ProofUnavailableError";
    this.cause = cause;
  }
}

export class Prover {
  /**
   * @param {object} opts - { wasmPath, zkeyPath, timeoutMs }
   * timeoutMs bounds each prove call; on expiry the promise rejects with
   * ProofUnavailableError (the underlying work is abandoned, not cancelled,
   * because snarkjs offers no cancellation; the process stays usable).
   */
  constructor({ wasmPath, zkeyPath, timeoutMs = 45000 }) {
    this.wasmPath = wasmPath;
    this.zkeyPath = zkeyPath;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Generate a proof for one task + decision.
   * @param {object} task - { task_id, ...input fields } (validated).
   * @param {0n|1n} decision - 1n APPROVE, 0n REJECT.
   * @returns {Promise<{ proof: object, publicSignals: string[] }>}
   * @throws {ProofUnavailableError} on encoding failure, witness assertion
   *   failure (inputs contradict the decision), timeout, or any snarkjs error.
   */
  async prove(task, decision) {
    let input;
    try {
      input = buildCircuitInput(task, decision, randomSalt());
    } catch (e) {
      if (e instanceof EncodingError) {
        throw new ProofUnavailableError(`cannot encode task inputs: ${e.message}`, e);
      }
      throw e;
    }
    const run = (async () => {
      try {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
          input,
          this.wasmPath,
          this.zkeyPath,
        );
        return { proof, publicSignals: publicSignals.map(String) };
      } catch (e) {
        throw new ProofUnavailableError(`snarkjs fullProve failed: ${e.message}`, e);
      }
    })();
    const timer = new Promise((_, reject) =>
      setTimeout(
        () => reject(new ProofUnavailableError(`prove timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      ),
    );
    return Promise.race([run, timer]);
  }
}
