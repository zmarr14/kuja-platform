// Simple in-memory rate limiter, keyed by whatever the caller chooses (usually api_key).
// No external dependency — a Map with fixed time windows is plenty at this scale.
// Note: resets on server restart/redeploy. That's an acceptable tradeoff here — this
// exists to stop obvious abuse (someone scripting requests against a leaked api_key),
// not to be a hard security boundary. If Kuja ever runs multiple server instances behind
// a load balancer, this would need to move to a shared store (e.g. Redis) instead.

const buckets = new Map();

function rateLimit({ windowMs, max, keyFn, message }) {
  return function (req, res, next) {
    const key = keyFn(req);
    if (!key) return next(); // nothing to key on — let normal validation reject the request instead

    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: message || 'Too many requests — please try again shortly.' });
    }
    next();
  };
}

// Periodic cleanup so the Map doesn't grow forever on a long-running server.
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 10 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

module.exports = { rateLimit };
