// Unit tests: persistent stores (seen-set + idempotency cache).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SeenSet, IdempotencyCache } from "../src/store.js";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gatekeeper-test-"));
}

test("SeenSet persists across reloads and tolerates a torn trailing line", () => {
  const dir = tmpdir();
  const file = path.join(dir, "seen.jsonl");
  const s1 = new SeenSet(file);
  s1.mark("0xabc", "task-1");
  s1.mark("0xdef", "task-2");
  assert.equal(s1.has("0xabc"), true);
  assert.equal(s1.size, 2);
  // Simulate a crash mid-append: torn last line.
  fs.appendFileSync(file, '{"proof_tx": "0x999", "task_id": ');
  const s2 = new SeenSet(file);
  assert.equal(s2.has("0xabc"), true);
  assert.equal(s2.has("0xdef"), true);
  assert.equal(s2.has("0x999"), false);
  assert.equal(s2.size, 2);
  // Marking an existing entry is a no-op (no duplicate line).
  const before = fs.readFileSync(file, "utf8");
  s2.mark("0xabc", "task-1");
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("IdempotencyCache persists atomically and survives reload", () => {
  const dir = tmpdir();
  const file = path.join(dir, "cache.json");
  const c1 = new IdempotencyCache(file);
  c1.put("t1", { body: '{"decision":"APPROVE"}', decision: "APPROVE", reason_code: "VALID_CONDITION", proof: true });
  assert.deepEqual(c1.get("t1").decision, "APPROVE");
  const c2 = new IdempotencyCache(file);
  assert.equal(c2.get("t1").body, '{"decision":"APPROVE"}');
  assert.equal(c2.get("missing"), null);
  assert.equal(fs.existsSync(file + ".tmp"), false);
});

test("IdempotencyCache starts empty on a corrupt file", () => {
  const dir = tmpdir();
  const file = path.join(dir, "cache.json");
  fs.writeFileSync(file, "{not json");
  const c = new IdempotencyCache(file);
  assert.equal(c.size, 0);
  c.put("t1", { body: "x" });
  assert.equal(c.get("t1").body, "x");
});
