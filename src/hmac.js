// HMAC-SHA256 request verification and response signing.
//
// Protocol (public docs): every request carries x-agent-games-signature
// computed over the RAW request body; every response must carry the same
// header computed over the RAW response body. The secret is the
// platform-issued 32-byte value from Rotate Secret, read ONLY from the
// AGENT_GAMES_HMAC_SECRET environment variable. Never hardcoded, never
// logged, never committed.
//
// ASSUMPTION: the header encoding is unspecified in the public docs.
// Verification accepts BOTH lowercase/uppercase hex and canonical base64
// encodings of the 32-byte digest (both are encodings of the same value, so
// accepting both loses no security). Responses are signed with lowercase
// hex. If preflight fails on signature, the encoding is the first suspect.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

function digest(secret, bodyBuffer) {
  return createHmac("sha256", secret).update(bodyBuffer).digest();
}

/** Decode a signature header into candidate digest buffers. */
function decodeCandidates(headerValue) {
  const out = [];
  if (typeof headerValue !== "string") return out;
  const v = headerValue.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    out.push(Buffer.from(v, "hex"));
  }
  // Canonical base64 of 32 bytes is 44 chars ending in "=".
  if (/^[A-Za-z0-9+/]{43}=$/.test(v)) {
    const buf = Buffer.from(v, "base64");
    if (buf.length === 32 && buf.toString("base64") === v) out.push(buf);
  }
  return out;
}

/**
 * Verify the request signature over the raw body bytes.
 * Constant-time comparison; returns false (never throws) on any mismatch,
 * missing header, or malformed value. Fail closed.
 */
export function verifySignature(secret, rawBodyBuffer, headerValue) {
  if (!secret || !Buffer.isBuffer(rawBodyBuffer)) return false;
  const expected = digest(secret, rawBodyBuffer);
  const candidates = decodeCandidates(headerValue);
  if (candidates.length === 0) return false;
  for (const cand of candidates) {
    if (cand.length === expected.length && timingSafeEqual(cand, expected)) {
      return true;
    }
  }
  return false;
}

/** Sign raw response bytes. Returns the lowercase hex signature. */
export function signBody(secret, rawBodyBuffer) {
  return digest(secret, rawBodyBuffer).toString("hex");
}
