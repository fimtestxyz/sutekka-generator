// In-memory per-key rate limit for the comment endpoint.
//
// Best-effort by design: each serverless instance keeps its own
// counters, so a burst spread across instances can exceed the
// limit. TODO: move to Redis (Upstash) when the site needs a
// shared limiter. Counters are pruned on each check, so memory
// does not grow without bound.
"use strict";

/** @type {Map<string, number[]>} */
const buckets = new Map();

/**
 * Record one attempt for `key`. Returns false when the key has
 * already used `limit` attempts inside the last `windowMs`.
 *
 * @param {string} key e.g. "comment:<uid>"
 * @param {number} [limit] default 10
 * @param {number} [windowMs] default 60_000
 * @returns {boolean}
 */
function checkRateLimit(key, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  const kept = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (kept.length >= limit) {
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
    return false;
  }
  kept.push(now);
  buckets.set(key, kept);
  return true;
}

/** Test seam only: clear all counters. */
function resetRateLimits() {
  buckets.clear();
}

module.exports = { checkRateLimit, resetRateLimits };
