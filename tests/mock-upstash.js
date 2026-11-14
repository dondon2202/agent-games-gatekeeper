// Minimal in-process fake of the Upstash Redis REST API, for tests and
// local measurement only. Implements exactly the surface the store uses:
// single commands via JSON-array POST body, /pipeline, /multi-exec, and
// Bearer auth. Response shapes mirror the real API: {result} on success,
// {error} with a 4xx status on auth/syntax failures. No network, no
// accounts, no real Upstash involved.
import http from "node:http";

const SUPPORTED = new Set(["SISMEMBER", "SADD", "GET", "SET", "SCARD", "DEL"]);

export function createMockUpstash({ token = "mock-upstash-token" } = {}) {
  const strings = new Map();
  const sets = new Map();
  const requests = [];

  function runCommand(cmd) {
    if (!Array.isArray(cmd) || cmd.length === 0 || typeof cmd[0] !== "string") {
      throw Object.assign(new Error("ERR invalid command"), { status: 400 });
    }
    const name = cmd[0].toUpperCase();
    if (!SUPPORTED.has(name)) {
      throw Object.assign(new Error(`ERR unknown command '${cmd[0]}'`), { status: 400 });
    }
    const args = cmd.slice(1).map(String);
    switch (name) {
      case "SISMEMBER": {
        const s = sets.get(args[0]);
        return s && s.has(args[1]) ? 1 : 0;
      }
      case "SADD": {
        let s = sets.get(args[0]);
        if (!s) { s = new Set(); sets.set(args[0], s); }
        const before = s.size;
        s.add(args[1]);
        return s.size - before;
      }
      case "GET": {
        return strings.has(args[0]) ? strings.get(args[0]) : null;
      }
      case "SET": {
        // Extra args (EX etc.) are accepted and ignored: the store never
        // sends them, and the mock does not model TTLs.
        strings.set(args[0], args[1]);
        return "OK";
      }
      case "SCARD": {
        return sets.get(args[0])?.size || 0;
      }
      case "DEL": {
        let n = 0;
        for (const k of args) {
          if (strings.delete(k)) n++;
          if (sets.delete(k)) n++;
        }
        return n;
      }
      default:
        throw Object.assign(new Error("ERR unreachable"), { status: 400 });
    }
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: "unauthorized" });
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(400, { error: "ERR invalid JSON" });
      return;
    }
    try {
      if (req.url === "/pipeline" || req.url === "/multi-exec") {
        if (!Array.isArray(body) || !body.every(Array.isArray)) {
          send(400, { error: "ERR pipeline body must be a 2D array" });
          return;
        }
        send(200, body.map((cmd) => ({ result: runCommand(cmd) })));
        return;
      }
      if (req.url === "/" || req.url === "") {
        if (!Array.isArray(body)) {
          send(400, { error: "ERR command body must be a JSON array" });
          return;
        }
        send(200, { result: runCommand(body) });
        return;
      }
      send(404, { error: "ERR unknown endpoint" });
    } catch (e) {
      send(e.status || 400, { error: e.message });
    }
  });

  return {
    server,
    requests,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    reset() {
      strings.clear();
      sets.clear();
      requests.length = 0;
    },
    dump() {
      return {
        strings: Object.fromEntries(strings),
        sets: Object.fromEntries([...sets].map(([k, v]) => [k, [...v]])),
      };
    },
  };
}
