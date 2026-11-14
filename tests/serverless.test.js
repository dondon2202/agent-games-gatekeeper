// Serverless-path tests: the Upstash Redis store (against a local mock of
// the Upstash REST API) and the Vercel function entries in api/ invoked
// directly with real WHATWG Request/Response objects carrying raw bodies +
// HMAC signatures. No network, no accounts, no real Upstash/Vercel.
//
// Env vars are read per invocation by api/task.js, so each test sets
// process.env before calling POST/GET and restores it afterwards.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { POST } from "../api/task.js";
import { GET } from "../api/health.js";
import { FileStore, UpstashRedisStore, UpstashError } from "../src/store.js";
import { verifySignature } from "../src/hmac.js";
import { createMockUpstash } from "./mock-upstash.js";

const SECRET = "serverless-test-secret-32-bytes!!";
const UPSTASH_TOKEN = "mock-upstash-token";
const VK = "0x" + "7d91".repeat(16);
const ADDR = "0xDe42a1b2c3d4e5f60718293a4b5c6d7e8f909f01";

const mock = createMockUpstash({ token: UPSTASH_TOKEN });
let mockUrl;

const ENV_KEYS = ["AGENT_GAMES_HMAC_SECRET", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
}
function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
function setUpstashEnv() {
  process.env.AGENT_GAMES_HMAC_SECRET = SECRET;
  process.env.UPSTASH_REDIS_REST_URL = mockUrl;
  process.env.UPSTASH_REDIS_REST_TOKEN = UPSTASH_TOKEN;
}

test.before(async () => {
  mockUrl = await mock.start();
});
test.after(async () => {
  await mock.close();
});

function envelope(taskId, input) {
  return {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "competition",
    issued_at: "2026-11-14T00:00:00Z",
    deadline_at: "2026-11-14T00:01:00Z",
    input,
  };
}

function validInput(proofTx) {
  return {
    registered_vk: VK, proof_vk: VK, minimum: "1000", public_balance: "1460",
    expiry_block: 8430000, current_block: 8420000,
    recipient: ADDR, condition_recipient: ADDR,
    amount: "500", max_transfer: "1000", proof_tx: proofTx,
  };
}

function proofTx(n) {
  return "0x" + n.toString(16).padStart(4, "0").repeat(16);
}

function signedRequest(bodyObject, { secret = SECRET, rawBody, signature } = {}) {
  const raw = rawBody ?? Buffer.from(JSON.stringify(bodyObject), "utf8");
  const sig = signature ?? createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("http://localhost/task", {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-games-signature": sig },
    body: raw,
  });
}

async function readResponse(res) {
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf, json: JSON.parse(buf.toString("utf8")) };
}

// ---------------------------------------------------------------------------
// Store conformance: identical semantics across FileStore and UpstashRedisStore
// ---------------------------------------------------------------------------

async function runConformance(makeStore, label) {
  const store = await makeStore();
  assert.equal(await store.hasSeen("0xabc"), false, `${label}: unseen initially`);
  assert.equal(await store.getCached("t-missing"), null, `${label}: cache miss initially`);
  await store.markSeen("0xabc", "task-1");
  assert.equal(await store.hasSeen("0xabc"), true, `${label}: seen after mark`);
  await store.markSeen("0xabc", "task-1");
  assert.equal(await store.hasSeen("0xabc"), true, `${label}: mark is idempotent`);
  const entry = { body: '{"decision":"APPROVE"}', decision: "APPROVE", reason_code: "VALID_CONDITION", proof: true };
  await store.putCached("t1", entry);
  assert.deepEqual(await store.getCached("t1"), entry, `${label}: cache round-trip`);
  const stats = await store.stats();
  assert.equal(stats.seen, 1, `${label}: stats.seen`);
  assert.equal(stats.cached, 1, `${label}: stats.cached`);
}

test("store conformance: FileStore", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-filestore-"));
  await runConformance(async () => new FileStore(dir), "FileStore");
});

test("store conformance: UpstashRedisStore against the mock REST API", async () => {
  mock.reset();
  const prefix = `gk:test-${Date.now()}:`;
  await runConformance(
    async () => new UpstashRedisStore({ url: mockUrl, token: UPSTASH_TOKEN, prefix }),
    "UpstashRedisStore",
  );
  // Auth: every request carried the Bearer token, none put it in the URL.
  assert.ok(mock.requests.length > 0);
  assert.ok(mock.requests.every((r) => r.auth === `Bearer ${UPSTASH_TOKEN}`));
  assert.ok(mock.requests.every((r) => !r.url.includes("_token=")));
});

test("UpstashRedisStore: unreachable endpoint fails closed on every op", async () => {
  const dead = new UpstashRedisStore({ url: "http://127.0.0.1:1", token: "x", timeoutMs: 500 });
  await assert.rejects(dead.hasSeen("0xabc"), UpstashError);
  await assert.rejects(dead.markSeen("0xabc", "t"), UpstashError);
  await assert.rejects(dead.getCached("t"), UpstashError);
  await assert.rejects(dead.putCached("t", { body: "x" }), UpstashError);
  await assert.rejects(dead.stats(), UpstashError);
});

test("UpstashRedisStore: wrong token -> auth error on every op", async () => {
  const bad = new UpstashRedisStore({ url: mockUrl, token: "wrong-token" });
  await assert.rejects(bad.hasSeen("0xabc"), /401/);
  await assert.rejects(bad.markSeen("0xabc", "t"), /401/);
});

test("UpstashRedisStore: corrupt cache entry fails closed", async () => {
  mock.reset();
  const store = new UpstashRedisStore({ url: mockUrl, token: UPSTASH_TOKEN, prefix: "gk:corrupt:" });
  // Write a non-JSON value straight through the mock's SET path.
  await store._command("SET", "gk:corrupt:cache:t-bad", "{not json");
  await assert.rejects(store.getCached("t-bad"), UpstashError);
});

// ---------------------------------------------------------------------------
// api/task.js: full trap suite through the serverless handler
// ---------------------------------------------------------------------------

test("serverless handler: full trap suite + auth + replay + preflight", { timeout: 180000 }, async (t) => {
  const saved = saveEnv();
  setUpstashEnv();
  mock.reset();
  t.after(() => restoreEnv(saved));

  const cases = [
    { name: "valid -> APPROVE", input: validInput(proofTx(1)), decision: "APPROVE", reason: "VALID_CONDITION", proof: true, proofDecision: "1" },
    { name: "VK_SUBSTITUTION", input: { ...validInput(proofTx(2)), proof_vk: "0x" + "13aa".repeat(16) }, decision: "REJECT", reason: "VK_SUBSTITUTION", proof: true, proofDecision: "0" },
    { name: "THRESHOLD_MISMATCH", input: { ...validInput(proofTx(3)), public_balance: "999" }, decision: "REJECT", reason: "THRESHOLD_MISMATCH", proof: true, proofDecision: "0" },
    { name: "EXPIRED_CONDITION", input: { ...validInput(proofTx(4)), current_block: 8430000 }, decision: "REJECT", reason: "EXPIRED_CONDITION", proof: true, proofDecision: "0" },
    { name: "RECIPIENT_MISMATCH", input: { ...validInput(proofTx(5)), recipient: "0x" + "11".repeat(20) }, decision: "REJECT", reason: "RECIPIENT_MISMATCH", proof: true, proofDecision: "0" },
    { name: "AMOUNT_OVERFLOW", input: { ...validInput(proofTx(6)), amount: "1001" }, decision: "REJECT", reason: "AMOUNT_OVERFLOW", proof: true, proofDecision: "0" },
  ];

  let firstMs = null;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    await t.test(c.name, async () => {
      const started = Date.now();
      const res = await POST(signedRequest(envelope(`gk_sls_${i}`, c.input)));
      const ms = Date.now() - started;
      if (firstMs === null) firstMs = ms;
      const r = await readResponse(res);
      assert.equal(r.status, 200);
      assert.equal(verifySignature(SECRET, r.body, r.headers.get("x-agent-games-signature")), true, "response signature valid");
      assert.equal(r.json.decision, c.decision);
      assert.equal(r.json.reason_code, c.reason);
      if (c.proof) {
        assert.equal(typeof r.json.proof, "object");
        assert.equal(r.json.proof.protocol, "groth16");
        assert.equal(r.json.public_signals.length, 13);
        assert.equal(r.json.public_signals[11], c.proofDecision);
      }
    });
  }
  // Cold-ish first request (first prove in this process) must fit the
  // platform deadline with wide margin; the number is logged for the report.
  console.log(`[serverless-test] first request (cold, incl. first prove): ${firstMs}ms`);
  assert.ok(firstMs < 60000, `first request ${firstMs}ms exceeds the 60s deadline`);

  await t.test("PROOF_REUSED: same proof_tx, new task_id -> REJECT, no proof", async () => {
    const res = await POST(signedRequest(envelope("gk_sls_reuse", validInput(proofTx(1)))));
    const r = await readResponse(res);
    assert.equal(r.status, 200);
    assert.equal(r.json.decision, "REJECT");
    assert.equal(r.json.reason_code, "PROOF_REUSED");
    assert.equal("proof" in r.json, false);
    assert.equal("public_signals" in r.json, false);
  });

  let firstBody;
  await t.test("replayed task_id returns byte-identical response", async () => {
    const req1 = signedRequest(envelope("gk_sls_replay", validInput(proofTx(7))));
    const r1 = await readResponse(await POST(req1));
    assert.equal(r1.status, 200);
    firstBody = r1.body.toString("utf8");
    const req2 = signedRequest(envelope("gk_sls_replay", validInput(proofTx(7))));
    const r2 = await readResponse(await POST(req2));
    assert.equal(r2.status, 200);
    assert.equal(r2.body.toString("utf8"), firstBody);
  });

  await t.test("bad signature -> 401, no state change", async () => {
    const before = await new UpstashRedisStore({ url: mockUrl, token: UPSTASH_TOKEN }).stats();
    const body = Buffer.from(JSON.stringify(envelope("gk_sls_badsig", validInput(proofTx(8)))), "utf8");
    const req = new Request("http://localhost/task", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-games-signature": createHmac("sha256", "wrong-secret").update(body).digest("hex") },
      body,
    });
    const r = await readResponse(await POST(req));
    assert.equal(r.status, 401);
    const after = await new UpstashRedisStore({ url: mockUrl, token: UPSTASH_TOKEN }).stats();
    assert.deepEqual(after, before);
  });

  await t.test("missing signature -> 401", async () => {
    const req = new Request("http://localhost/task", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(envelope("gk_sls_nosig", validInput(proofTx(9)))), "utf8"),
    });
    const r = await readResponse(await POST(req));
    assert.equal(r.status, 401);
  });

  await t.test("tampered body -> 401 (signature covers raw bytes)", async () => {
    const original = Buffer.from(JSON.stringify(envelope("gk_sls_tamper", validInput(proofTx(10)))), "utf8");
    const sig = createHmac("sha256", SECRET).update(original).digest("hex");
    const tampered = Buffer.from(original.toString("utf8").replace('"1460"', '"9999"'), "utf8");
    const req = new Request("http://localhost/task", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-games-signature": sig },
      body: tampered,
    });
    const r = await readResponse(await POST(req));
    assert.equal(r.status, 401);
  });

  await t.test("preflight -> signed {ok, protocolVersion}", async () => {
    const req = signedRequest({ type: "agent-games.preflight.v1", agent_id: "agt_x", issued_at: "2026-11-14T00:00:00Z", nonce: "abc123" });
    const r = await readResponse(await POST(req));
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, protocolVersion: "v1" });
    assert.equal(verifySignature(SECRET, r.body, r.headers.get("x-agent-games-signature")), true);
  });

  await t.test("malformed JSON with valid HMAC -> 400", async () => {
    const raw = Buffer.from("{not json", "utf8");
    const req = signedRequest(null, { rawBody: raw });
    const r = await readResponse(await POST(req));
    assert.equal(r.status, 400);
  });

  await t.test("unknown envelope type -> 400", async () => {
    const r = await readResponse(await POST(signedRequest({ type: "something.else.v1" })));
    assert.equal(r.status, 400);
  });

  await t.test("malformed task input -> REJECT INVALID_INPUT, no proof", async () => {
    const r = await readResponse(await POST(signedRequest(envelope("gk_sls_badinput", { ...validInput(proofTx(11)), amount: "lots" }))));
    assert.equal(r.status, 200);
    assert.equal(r.json.decision, "REJECT");
    assert.equal(r.json.reason_code, "INVALID_INPUT");
    assert.equal("proof" in r.json, false);
  });

  await t.test("health GET -> 200 with Upstash stats", async () => {
    const res = await GET();
    const r = await readResponse(res);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.storage, "upstash");
    assert.equal(r.json.storage_ok, true);
    assert.ok(typeof r.json.seen_proofs === "number" && r.json.seen_proofs >= 7);
    assert.ok(typeof r.json.cached_tasks === "number" && r.json.cached_tasks >= 7);
  });
});

test("serverless handler: missing env fails loud with 500, never stateless", async () => {
  const saved = saveEnv();
  try {
    delete process.env.AGENT_GAMES_HMAC_SECRET;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const r1 = await readResponse(await POST(signedRequest(envelope("gk_sls_noenv", validInput(proofTx(12))))));
    assert.equal(r1.status, 500);
    assert.equal(r1.json.error, "internal error");

    process.env.AGENT_GAMES_HMAC_SECRET = SECRET;
    const r2 = await readResponse(await POST(signedRequest(envelope("gk_sls_noenv2", validInput(proofTx(13))))));
    assert.equal(r2.status, 500, "secret without Upstash must not run stateless");

    const r3 = await readResponse(await GET());
    assert.equal(r3.status, 500);
  } finally {
    restoreEnv(saved);
  }
});
