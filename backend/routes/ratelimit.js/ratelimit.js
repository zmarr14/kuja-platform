// Simple in-memory rate limiter, keyed by whatever the caller chooses (usually api_key).
const buckets = new Map();

function rateLimit({ windowMs, max, keyFn, message }) {
  return function (req, res, next) {
    const key = keyFn(req);
    if (!key) return next();

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

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}, 10 * 60 * 1000);
if (cleanupInterval.unref) cleanupInterval.unref();

module.exports = { rateLimit };
