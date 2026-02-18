/** @format */

const buckets = new Map();

const cleanupStaleBuckets = (windowMs) => {
	const now = Date.now();
	for (const [key, bucket] of buckets.entries()) {
		if (now - bucket.windowStart > windowMs * 2) {
			buckets.delete(key);
		}
	}
};

module.exports = ({ windowMs = 60_000, max = 20, keyPrefix = 'global' } = {}) => {
	return (req, res, next) => {
		const key = `${keyPrefix}:${req.ip || 'unknown'}`;
		const now = Date.now();
		const bucket = buckets.get(key) || { windowStart: now, count: 0 };

		if (now - bucket.windowStart > windowMs) {
			bucket.windowStart = now;
			bucket.count = 0;
		}

		bucket.count += 1;
		buckets.set(key, bucket);
		cleanupStaleBuckets(windowMs);

		if (bucket.count > max) {
			return res.status(429).json({
				message: 'Trop de requêtes. Veuillez réessayer dans quelques instants.',
			});
		}

		return next();
	};
};

