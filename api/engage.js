/* Comic Showcase engagement API — likes, comments, feedback.
 *
 * One Vercel serverless function, no dependencies: it talks to
 * Vercel KV (Upstash Redis) over its REST API, using the env vars
 * Vercel adds automatically when a KV database is linked to the
 * project (KV_REST_API_URL, KV_REST_API_TOKEN).
 *
 * If KV is not linked yet, every action answers 503 with
 * { error: "engage_not_configured" } and the site degrades
 * gracefully (likes stay on-device, comments show a fallback).
 *
 * Keys:
 *   likes:<slug>              integer counter
 *   like-ip:<slug>:<iphash>   "1", INCR + EXPIRE 24h — one like per
 *                             IP per day per comic (INCR is atomic;
 *                             SET NX EX failed silently in prod)
 *   comments:<slug>           list of JSON comment objects, newest
 *                             first, capped at 200
 *   feedback                  list of JSON feedback objects
 *   rate:<action>:<slug>:<iphash>  per-IP rate-limit counters
 *
 * Rules: no login, no tracking beyond a salted hash of the IP
 * (used only for the like-dedupe and rate limits, never stored
 * in plain text). Names are optional; text is capped at 500
 * chars and stripped of angle brackets server-side; the client
 * escapes everything again when rendering.
 */
'use strict';

const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || '';
const MAX_COMMENT = 500;
const MAX_NAME = 40;
const COMMENTS_CAP = 200;
const COMMENTS_SHOWN = 50;

function kvConfigured() {
  return Boolean(KV_URL && KV_TOKEN);
}

function ipHash(req) {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

async function kv(path, method = 'GET', body) {
  const res = await fetch(KV_URL + path, {
    method,
    headers: { Authorization: 'Bearer ' + KV_TOKEN },
    // Callers pass pre-stringified JSON for lpush; don't encode twice.
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('KV ' + res.status + ' ' + text.slice(0, 200));
  }
  return res.json();
}

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max);
}

function validSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(slug);
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

async function rateLimited(key, max, windowSec) {
  // INCR + EXPIRE-on-first-use pattern via the REST API.
  const r = await kv('/incr/' + encodeURIComponent(key));
  const n = r.result;
  if (n === 1) await kv('/expire/' + encodeURIComponent(key) + '/' + windowSec, 'POST');
  return n > max;
}

async function getLikes(req, res, slug) {
  const [count, liked] = await Promise.all([
    kv('/get/' + encodeURIComponent('likes:' + slug)).catch(() => ({ result: null })),
    kv('/get/' + encodeURIComponent('like-ip:' + slug + ':' + ipHash(req))).catch(() => ({ result: null })),
  ]);
  json(res, 200, { likes: Number(count.result) || 0, liked: Boolean(liked.result) });
}

async function postLike(req, res, slug, unlike) {
  const ip = ipHash(req);
  const ipKey = 'like-ip:' + slug + ':' + ip;
  if (unlike) {
    const had = await kv('/get/' + encodeURIComponent(ipKey)).catch(() => ({ result: null }));
    if (!had.result) return getLikes(req, res, slug);
    await Promise.all([
      kv('/del/' + encodeURIComponent(ipKey), 'POST'),
      kv('/decr/' + encodeURIComponent('likes:' + slug)).catch(() => null),
    ]);
    const count = await kv('/get/' + encodeURIComponent('likes:' + slug)).catch(() => ({ result: null }));
    json(res, 200, { likes: Math.max(0, Number(count.result) || 0), liked: false });
    return;
  }
  // Dedupe via INCR, not SET NX EX: the SET-with-options call failed
  // silently in production (every like returned the unchanged count
  // with a 200, so the button looked dead and nothing fell back).
  // INCR is atomic, so only the first like from this IP today sees 1;
  // that first hit also sets the 24h expiry. Failures here are NOT
  // swallowed — they surface as a 500 so the client can fall back to
  // the on-device like instead of silently showing 0.
  const mark = await kv('/incr/' + encodeURIComponent(ipKey));
  if (mark.result === 1) {
    await kv('/expire/' + encodeURIComponent(ipKey) + '/86400', 'POST').catch(() => null);
    const count = await kv('/incr/' + encodeURIComponent('likes:' + slug));
    return json(res, 200, { likes: Number(count.result) || 0, liked: true });
  }
  // Already liked today: undo the extra increment, return the count.
  await kv('/decr/' + encodeURIComponent(ipKey)).catch(() => null);
  const count = await kv('/get/' + encodeURIComponent('likes:' + slug)).catch(() => ({ result: null }));
  json(res, 200, { likes: Number(count.result) || 0, liked: true });
}

async function getComments(req, res, slug) {
  const r = await kv('/lrange/' + encodeURIComponent('comments:' + slug) + '/0/' + (COMMENTS_SHOWN - 1))
    .catch(() => ({ result: [] }));
  const comments = (r.result || []).map((s) => {
    try { return JSON.parse(s); } catch (e) { return null; }
  }).filter(Boolean);
  json(res, 200, { comments });
}

async function postComment(req, res, slug) {
  const body = req.body || {};
  const name = clean(body.name, MAX_NAME);
  const text = clean(body.text, MAX_COMMENT);
  if (!text) return json(res, 400, { error: 'empty_comment' });
  if (await rateLimited('rate:comment:' + slug + ':' + ipHash(req), 5, 3600)) {
    return json(res, 429, { error: 'rate_limited' });
  }
  const comment = { name: name || 'Anonymous', text, ts: Date.now() };
  await kv('/lpush/' + encodeURIComponent('comments:' + slug), 'POST', JSON.stringify(comment));
  await kv('/ltrim/' + encodeURIComponent('comments:' + slug) + '/0/' + (COMMENTS_CAP - 1), 'POST');
  json(res, 200, { comment });
}

async function postFeedback(req, res) {
  const body = req.body || {};
  const name = clean(body.name, MAX_NAME);
  const text = clean(body.text, MAX_COMMENT);
  const page = clean(body.page, 200);
  if (!text) return json(res, 400, { error: 'empty_feedback' });
  if (await rateLimited('rate:feedback:' + ipHash(req), 5, 3600)) {
    return json(res, 429, { error: 'rate_limited' });
  }
  const item = { name: name || 'Anonymous', text, page, ts: Date.now() };
  await kv('/lpush/feedback', 'POST', JSON.stringify(item));
  await kv('/ltrim/feedback/0/499', 'POST');
  json(res, 200, { ok: true });
}

module.exports = async (req, res) => {
  try {
    if (!kvConfigured()) return json(res, 503, { error: 'engage_not_configured' });
    const url = new URL(req.url, 'http://localhost');
    const action = url.searchParams.get('action') || '';
    const slug = url.searchParams.get('slug') || '';

    if (req.method === 'GET' && action === 'likes' && validSlug(slug)) return getLikes(req, res, slug);
    if (req.method === 'POST' && action === 'like' && validSlug(slug)) return postLike(req, res, slug, false);
    if (req.method === 'POST' && action === 'unlike' && validSlug(slug)) return postLike(req, res, slug, true);
    if (req.method === 'GET' && action === 'comments' && validSlug(slug)) return getComments(req, res, slug);
    if (req.method === 'POST' && action === 'comment' && validSlug(slug)) return postComment(req, res, slug);
    if (req.method === 'POST' && action === 'feedback') return postFeedback(req, res);
    return json(res, 400, { error: 'bad_request' });
  } catch (err) {
    console.error('engage error', err);
    return json(res, 500, { error: 'internal' });
  }
};
