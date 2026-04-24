/** @format */

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../services/redisService');
const { logSecurityEvent } = require('../services/securityAuditService');

let globalLimiter = null;
let sensitiveLimiter = null;
let webhookLimiter = null;
let buildingPromise = null;

const buildLimiter = async ({ windowMs, max, prefix }) => {
	const redis = await getRedisClient();
	if (!redis) {
		return rateLimit({
			windowMs,
			max,
			standardHeaders: true,
			legacyHeaders: false,
			message: {
				message: 'Trop de requêtes. Veuillez réessayer plus tard.',
			},
			handler: (req, res, _next, options) => {
				logSecurityEvent({
					event: 'rate_limit_exceeded',
					level: 'warning',
					action: req?.path || 'unknown',
					code: 'RATE_LIMIT',
					message: 'Trop de requêtes.',
					userId: req?.userId || null,
					userEmail: req?.userEmail || req?.user?.email || null,
					ip: req?.ip || null,
					userAgent: req?.headers?.['user-agent'] || null,
					meta: {
						windowMs,
						max,
						prefix,
						method: req?.method || null,
					},
				});
				return res.status(options.statusCode).json(options.message);
			},
		});
	}

	return rateLimit({
		windowMs,
		max,
		standardHeaders: true,
		legacyHeaders: false,
		message: {
			message: 'Trop de requêtes. Veuillez réessayer plus tard.',
		},
		handler: (req, res, _next, options) => {
			logSecurityEvent({
				event: 'rate_limit_exceeded',
				level: 'warning',
				action: req?.path || 'unknown',
				code: 'RATE_LIMIT',
				message: 'Trop de requêtes.',
				userId: req?.userId || null,
				userEmail: req?.userEmail || req?.user?.email || null,
				ip: req?.ip || null,
				userAgent: req?.headers?.['user-agent'] || null,
				meta: {
					windowMs,
					max,
					prefix,
					method: req?.method || null,
				},
			});
			return res.status(options.statusCode).json(options.message);
		},
		store: new RedisStore({
			prefix: `${prefix}:`,
			sendCommand: (...args) => redis.call(args[0], ...args.slice(1)),
		}),
	});
};

const ensureLimiters = async () => {
	if (globalLimiter && sensitiveLimiter && webhookLimiter) return;
	if (buildingPromise) return buildingPromise;

	buildingPromise = (async () => {
		globalLimiter = await buildLimiter({
			windowMs: 60 * 1000,
			max: 240,
			prefix: 'rl-global',
		});
		sensitiveLimiter = await buildLimiter({
			windowMs: 60 * 1000,
			max: 40,
			prefix: 'rl-sensitive',
		});
		webhookLimiter = await buildLimiter({
			windowMs: 60 * 1000,
			max: 600,
			prefix: 'rl-webhook',
		});
	})();
	await buildingPromise;
	buildingPromise = null;
};

const asMiddleware = (limiterGetter) => async (req, res, next) => {
	try {
		await ensureLimiters();
		const limiter = limiterGetter();
		return limiter(req, res, next);
	} catch (error) {
		console.error('securityRateLimit error:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

module.exports = {
	globalRateLimit: asMiddleware(() => globalLimiter),
	sensitiveRateLimit: asMiddleware(() => sensitiveLimiter),
	webhookRateLimit: asMiddleware(() => webhookLimiter),
};
