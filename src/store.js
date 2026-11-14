// Persistent state: proof_tx seen-set + task_id idempotency cache.
//
// Two backends behind ONE async interface, so the local server and the
// serverless function share the same decision/prove/sign pipeline:
//
//   hasSeen(proofTxLower)          -> Promise<boolean>   (throws on failure)
//   markSeen(proofTxLower, taskId) -> Promise<void>      (durable before it
//                                                        resolves; throws
//                                                        on failure)
//   getCached(taskId)              -> Promise<entry|null> (throws on failure)
//   putCached(taskId, entry)       -> Promise<void>      (throws on failure)
//   stats()                        -> Promise<{seen, cached}> (counts, or
//                                                        nulls when unknown)
//
// Semantics are identical across backends:
// - A seen-mark is durable before markSeen resolves. If it throws, the
//   caller must refuse to answer (503) rather than risk a later duplicate
//   slipping through; the platform retries.
// - A retried task_id returns the byte-identical cached response.
// - Any store failure fails closed (the caller returns 503); a failure is
//   NEVER silently treated as "not seen" or "not cached".
// No secrets are ever stored: proof refs and task ids are public task
// data, and cached responses contain only proofs/decisions.
//
// Backends:
// - FileStore (local default): the original SeenSet (append-only JSONL +
//   fsync) and IdempotencyCache (atomic tmp+fsync+rename JSON) under data/.
// - UpstashRedisStore (serverless): raw fetch against the Upstash Redis
//   REST API (no SDK). Keys: `<prefix>seen` (SET of proof refs),
//   `<prefix>cache:<taskId>` (STRING, JSON entry),
//   `<prefix>cache:ids` (SET of cached task ids, for stats).

import fs from "node:fs";
import path from "node:path";

const MAX_CACHE_ENTRIES = 10000;

// ---------------------------------------------------------------------------
// File-backed primitives (unchanged; unit-tested directly in tests/store.test.js)
// ---------------------------------------------------------------------------

export class SeenSet {
  constructor(filePath) {
    this.filePath = filePath;
    this.set = new Set();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec.proof_tx === "string") this.set.add(rec.proof_tx);
        } catch {
          // Skip a torn trailing line; the fsync-before-respond discipline
          // makes partial lines possible only after a crash mid-append.
        }
      }
    }
  }

  has(proofTxLower) {
    return this.set.has(proofTxLower);
  }

  get size() {
    return this.set.size;
  }

  /** Append + fsync. Throws on I/O failure; caller must fail closed. */
  mark(proofTxLower, taskId) {
    if (this.set.has(proofTxLower)) return;
    const line = JSON.stringify({ proof_tx: proofTxLower, task_id: taskId, ts: new Date().toISOString() }) + "\n";
    const fd = fs.openSync(this.filePath, "a");
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.set.add(proofTxLower);
  }
}

export class IdempotencyCache {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (data && typeof data === "object") {
          for (const [k, v] of Object.entries(data)) {
            if (v && typeof v.body === "string") this.map.set(k, v);
          }
        }
      } catch {
        // Corrupt cache file: start empty (worst case is a re-decision,
        // which is still deterministic; the seen-set guards double use).
        this.map = new Map();
      }
    }
  }

  get(taskId) {
    return this.map.get(taskId) || null;
  }

  get size() {
    return this.map.size;
  }

  /** Store + persist atomically. Throws on I/O failure. */
  put(taskId, entry) {
    this.map.set(taskId, entry);
    while (this.map.size > MAX_CACHE_ENTRIES) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    const tmp = this.filePath + ".tmp";
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeSync(fd, JSON.stringify(Object.fromEntries(this.map)));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// FileStore: async interface over the file-backed primitives (local default)
// ---------------------------------------------------------------------------

export class FileStore {
  constructor(dataDir) {
    this.seenSet = new SeenSet(path.join(dataDir, "seen_proofs.jsonl"));
    this.cache = new IdempotencyCache(path.join(dataDir, "idempotency.json"));
  }

  async hasSeen(proofTxLower) {
    return this.seenSet.has(proofTxLower);
  }

  async markSeen(proofTxLower, taskId) {
    this.seenSet.mark(proofTxLower, taskId);
  }

  async getCached(taskId) {
    return this.cache.get(taskId);
  }

  async putCached(taskId, entry) {
    this.cache.put(taskId, entry);
  }

  async stats() {
    return { seen: this.seenSet.size, cached: this.cache.size };
  }
}

// ---------------------------------------------------------------------------
// UpstashRedisStore: async interface over the Upstash Redis REST API.
// Raw fetch, no SDK. One HTTP request per command (JSON-array POST body
// form, which avoids all URL-encoding pitfalls for values carrying proofs).
// ---------------------------------------------------------------------------

export class UpstashError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UpstashError";
  }
}

const DEFAULT_UPSTASH_TIMEOUT_MS = 5000;

export class UpstashRedisStore {
  /**
   * @param {object} opts - { url, token, prefix?, timeoutMs?, fetchImpl? }
   * url/token are the Upstash REST URL and REST token (standard
   * read-write token). prefix namespaces all keys (default "gk:").
   */
  constructor({ url, token, prefix = "gk:", timeoutMs = DEFAULT_UPSTASH_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    if (!url || !token) {
      throw new Error("UpstashRedisStore requires url and token");
    }
    this.baseUrl = String(url).replace(/\/+$/, "");
    this.token = token;
    this.prefix = prefix;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.seenKey = `${prefix}seen`;
    this.cacheIdsKey = `${prefix}cache:ids`;
  }

  _cacheKey(taskId) {
    return `${this.prefix}cache:${taskId}`;
  }

  async _request(pathSuffix, jsonBody) {
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + pathSuffix, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: jsonBody,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new UpstashError(`Upstash request failed: ${e.message}`, { cause: e });
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new UpstashError(`Upstash returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok) {
      throw new UpstashError(`Upstash HTTP ${res.status}: ${(data && data.error) || "unknown error"}`);
    }
    if (data && typeof data === "object" && data.error) {
      throw new UpstashError(`Upstash error: ${data.error}`);
    }
    return data;
  }

  /** Single command via the JSON-array POST body form. Returns `result`. */
  async _command(...args) {
    const data = await this._request("", JSON.stringify(args));
    if (!data || typeof data !== "object" || !("result" in data)) {
      throw new UpstashError("Upstash response missing result");
    }
    return data.result;
  }

  /** Batch via /pipeline or /multi-exec. Returns the array of `result`s. */
  async _batch(endpoint, commands) {
    const data = await this._request(endpoint, JSON.stringify(commands));
    if (!Array.isArray(data)) {
      throw new UpstashError(`Upstash ${endpoint} response was not an array`);
    }
    return data.map((item, i) => {
      if (item && typeof item === "object" && item.error) {
        throw new UpstashError(`Upstash ${endpoint} command ${i} failed: ${item.error}`);
      }
      if (!item || typeof item !== "object" || !("result" in item)) {
        throw new UpstashError(`Upstash ${endpoint} response item ${i} missing result`);
      }
      return item.result;
    });
  }

  async hasSeen(proofTxLower) {
    const r = await this._command("SISMEMBER", this.seenKey, proofTxLower);
    return r === 1 || r === "1";
  }

  /**
   * SADD is atomic and idempotent: the mark is durable once the REST call
   * acknowledges (Upstash persists on write ack). Throws on any failure.
   */
  async markSeen(proofTxLower, _taskId) {
    await this._command("SADD", this.seenKey, proofTxLower);
  }

  async getCached(taskId) {
    const raw = await this._command("GET", this._cacheKey(taskId));
    if (raw === null || raw === undefined) return null;
    try {
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.body !== "string") throw new Error("bad shape");
      return entry;
    } catch (e) {
      throw new UpstashError(`corrupt cache entry for task ${taskId}`, { cause: e });
    }
  }

  /**
   * SET + index SADD in one /multi-exec transaction, so the entry and its
   * stats index are written atomically. No TTL: entries are tiny (one
   * response per task, ~64 scored tasks + practice) and must survive for
   * the whole event + judging window; the file backend likewise keeps
   * entries until its 10k-entry cap.
   */
  async putCached(taskId, entry) {
    await this._batch("/multi-exec", [
      ["SET", this._cacheKey(taskId), JSON.stringify(entry)],
      ["SADD", this.cacheIdsKey, taskId],
    ]);
  }

  async stats() {
    const [seen, cached] = await this._batch("/pipeline", [
      ["SCARD", this.seenKey],
      ["SCARD", this.cacheIdsKey],
    ]);
    return { seen: Number(seen), cached: Number(cached) };
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Upstash when both REST env vars are set, else the local file backend. */
export function createStoreFromEnv(env, { dataDir }) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return new UpstashRedisStore({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return new FileStore(dataDir);
}

/** Serverless entry: Upstash is mandatory (no durable local filesystem). */
export function requireUpstashStore(env) {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be set");
  }
  return new UpstashRedisStore({ url, token });
}
