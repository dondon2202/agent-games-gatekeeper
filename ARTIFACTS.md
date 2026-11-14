# Circuit artifacts

Downloaded 2026-11-14 (local time) from the public zkVerify Agent Games site.
No registration, no login, no secrets involved.

| File | Size (bytes) | SHA-256 |
|---|---|---|
| `circuits/gatekeeper.wasm` | 1,755,820 | `be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f` |
| `circuits/gatekeeper_final.zkey` | 309,750 | `adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d` |
| `circuits/verification_key.json` | (exported locally) | `snarkjs zkey export verificationkey` from the zkey above |

Sources (public):

- https://agentgames.zkverify.io/circuits/gatekeeper.wasm
- https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey
- Metadata: https://agentgames.zkverify.io/api/circuit-info
  (vkHash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`,
  registered on zkVerify mainnet per the site)

## Verified circuit facts (from the artifacts themselves)

- Protocol: Groth16, curve BN128 (alt_bn128), Circom 2.x (witness
  calculator reports version 2).
- Template name (from wasm assertion messages): `GatekeeperEvaluation`.
- Public signals: 13 (`nPublic` from the exported verification key).
- Total witness signals: 647 (`getWitnessSize` / zkey header `nVars`).
- Constraint domain size: 1024 (zkey header), so at most 1024 constraints.
- Input signals: 13 total (wasm `getInputSize`), recovered by name via the
  wasm's FNV-hash signal lookup (see `scripts/discover-inputs.js`):
  `registeredVkHash`, `proofVkHash`, `minimum`, `publicBalance`,
  `expiryBlock`, `currentBlock`, `recipient`, `conditionRecipient`,
  `amount`, `maxTransfer`, `decision`, `taskId` (all public) and `salt`
  (private). Each is a single field element (size 1).
- Public signals, in order (witness indices 1..13):
  1. `Poseidon(salt, taskId)` — a computed binding commitment (verified
     against circomlibjs Poseidon, see `scripts/probe-poseidon.js`).
  2. `registeredVkHash`
  3. `proofVkHash`
  4. `minimum`
  5. `publicBalance`
  6. `expiryBlock`
  7. `currentBlock`
  8. `recipient`
  9. `conditionRecipient`
  10. `amount`
  11. `maxTransfer`
  12. `decision`
  13. `taskId`
- Constraints (verified by satisfiability probing, see
  `scripts/probe-satisfy.js` and `scripts/probe-reject.js`):
  `decision == 1` iff all of: vk hashes equal, `publicBalance >= minimum`,
  `currentBlock < expiryBlock` (STRICT), recipients equal,
  `amount <= maxTransfer`. `decision` is boolean. `salt` and `taskId` are
  otherwise unconstrained.
- The other track's circuit (`vfyPolicy`, vkHash
  `0x6c56509f...be047`) is listed in the same API response but was NOT
  downloaded: out of scope for the Proof Gatekeeper scaffold.

Re-verify hashes any time with:
`sha256sum circuits/gatekeeper.wasm circuits/gatekeeper_final.zkey`
