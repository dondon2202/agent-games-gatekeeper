// Fresh-process measurement for the serverless handler: cold timings +
// proof that the serverless path writes nothing to the filesystem.
//
// Usage (from anywhere; the script resolves artifacts itself):
//   node scripts/measure-handler.js
// Run it with cwd and TMPDIR pointed at fresh empty dirs to verify the
// no-write property: both must stay empty afterwards.
//
// Exits explicitly: snarkjs leaves the event loop alive after proving.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { createMockUpstash } from "../tests/mock-upstash.js";

function snapshot(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
}

const cwdBefore = snapshot(process.cwd());
const tmpBefore = snapshot(os.tmpdir());

const mock = createMockUpstash({ token: "measure-token" });
const mockUrl = await mock.start();

process.env.AGENT_GAMES_HMAC_SECRET = "measure-secret-32-bytes-long!!!";
process.env.UPSTASH_REDIS_REST_URL = mockUrl;
process.env.UPSTASH_REDIS_REST_TOKEN = "measure-token";

const tImport0 = Date.now();
const { POST } = await import("../api/task.js");
const tImport = Date.now() - tImport0;

const VK = "0x" + "7d91".repeat(16);
const ADDR = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01";
function makeRequest(taskId, proofTx) {
  const body = Buffer.from(JSON.stringify({
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: "2026-11-14T00:00:00Z",
    deadline_at: "2026-11-14T00:01:00Z",
    input: {
      registered_vk: VK, proof_vk: VK, minimum: "1000", public_balance: "1460",
      expiry_block: 8430000, current_block: 8420000,
      recipient: ADDR, condition_recipient: ADDR,
      amount: "500", max_transfer: "1000", proof_tx: proofTx,
    },
  }), "utf8");
  return new Request("http://localhost/task", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-games-signature": createHmac("sha256", process.env.AGENT_GAMES_HMAC_SECRET).update(body).digest("hex"),
    },
    body,
  });
}

const t0 = Date.now();
const res1 = await POST(makeRequest("gk_measure_cold", "0x" + "aa11".repeat(16)));
const coldMs = Date.now() - t0;
const json1 = JSON.parse(Buffer.from(await res1.arrayBuffer()).toString("utf8"));

const t1 = Date.now();
const res2 = await POST(makeRequest("gk_measure_warm", "0x" + "bb22".repeat(16)));
const warmMs = Date.now() - t1;
const json2 = JSON.parse(Buffer.from(await res2.arrayBuffer()).toString("utf8"));

const cwdAfter = snapshot(process.cwd());
const tmpAfter = snapshot(os.tmpdir());
const newInCwd = cwdAfter.filter((f) => !cwdBefore.includes(f));
const newInTmp = tmpAfter.filter((f) => !tmpBefore.includes(f));

console.log(JSON.stringify({
  import_ms: tImport,
  cold_first_request_ms: coldMs,
  warm_second_request_ms: warmMs,
  cold_status: res1.status,
  cold_decision: json1.decision,
  cold_reason: json1.reason_code,
  cold_proof_present: typeof json1.proof === "object",
  warm_status: res2.status,
  warm_decision: json2.decision,
  new_files_in_cwd: newInCwd,
  new_files_in_tmpdir: newInTmp,
}, null, 2));

await mock.close();
process.exit(0);
