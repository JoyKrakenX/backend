/** @format */

const { getRedisClient } = require('../redisService');
const { FRAUD_CONFIG } = require('../../utils/fraudConfig');

const CACHE_TTL_SECONDS = 6 * 60 * 60;
const CIRCUIT_FAIL_THRESHOLD = Math.max(
	1,
	Number.parseInt(process.env.IPQS_CIRCUIT_FAIL_THRESHOLD || '5', 10) || 5,
);
const CIRCUIT_COOLDOWN_MS = Math.max(
	1000,
	Number.parseInt(process.env.IPQS_CIRCUIT_COOLDOWN_MS || '60000', 10) || 60000,
);
const ipqsCircuitState = {
	failures: 0,
	openedUntil: 0,
};

const isCircuitOpen = () => Date.now() < Number(ipqsCircuitState.openedUntil || 0);
const registerSuccess = () => {
	ipqsCircuitState.failures = 0;
	ipqsCircuitState.openedUntil = 0;
};
const registerFailure = () => {
	ipqsCircuitState.failures += 1;
	if (ipqsCircuitState.failures >= CIRCUIT_FAIL_THRESHOLD) {
		ipqsCircuitState.openedUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
	}
};

const buildIpqsUrl = (apiKey, ip) => {
	const safeIp = encodeURIComponent(String(ip || '').trim());
	return `https://ipqualityscore.com/api/json/ip/${encodeURIComponent(
		apiKey,
	)}/${safeIp}?strictness=1&fast=true&lighter_penalties=true&allow_public_access_points=true`;
};

const normalizeIpRisk = (payload = {}) => {
	if (typeof payload.fraud_score === 'number') {
		return Math.min(Math.max(payload.fraud_score, 0), 100);
	}

	let score = 0;
	if (payload.proxy) score += 35;
	if (payload.vpn) score += 35;
	if (payload.tor) score += 40;
	if (payload.recent_abuse) score += 35;
	if (payload.bot_status) score += 30;
	if (payload.is_crawler) score += 20;
	if (payload.active_vpn) score += 25;
	if (payload.connection_type === 'Corporate') score += 10;
	if (payload.connection_type === 'Data Center/Web Hosting/Transit') score += 25;
	return Math.min(Math.max(score, 0), 100);
};

const getIpReputation = async ({ ip, ipHash }) => {
	if (!FRAUD_CONFIG.ipqsEnabled) {
		return {
			provider: 'none',
			score: 0,
			timedOut: false,
			cached: false,
			raw: null,
		};
	}

	const apiKey = String(process.env.IPQS_API_KEY || '').trim();
	if (!apiKey) {
		return {
			provider: 'none',
			score: 0,
			timedOut: false,
			misconfigured: true,
			cached: false,
			raw: null,
		};
	}

	if (!ip) {
		return {
			provider: 'none',
			score: 0,
			timedOut: false,
			cached: false,
			raw: null,
		};
	}

	if (isCircuitOpen()) {
		return {
			provider: 'ipqs',
			score: 0,
			timedOut: true,
			cached: false,
			circuitOpen: true,
			raw: null,
		};
	}

	const cacheKey = `fraud:ipqs:${String(ipHash || ip)}`;
	const redis = await getRedisClient();
	if (redis) {
		const cachedRaw = await redis.get(cacheKey);
		if (cachedRaw) {
			const parsed = JSON.parse(cachedRaw);
			return {
				provider: 'ipqs',
				score: Number(parsed.score || 0),
				timedOut: false,
				cached: true,
				raw: parsed.raw || null,
			};
		}
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		Math.max(300, Number(FRAUD_CONFIG.ipqsTimeoutMs || 1200)),
	);

	try {
		const response = await fetch(buildIpqsUrl(apiKey, ip), {
			method: 'GET',
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`IPQS_HTTP_${response.status}`);
		}
		const payload = await response.json().catch(() => ({}));
		const score = normalizeIpRisk(payload);
		const normalized = {
			provider: 'ipqs',
			score,
			timedOut: false,
			cached: false,
			raw: {
				fraud_score: payload?.fraud_score ?? null,
				vpn: Boolean(payload?.vpn),
				proxy: Boolean(payload?.proxy),
				tor: Boolean(payload?.tor),
				recent_abuse: Boolean(payload?.recent_abuse),
				bot_status: Boolean(payload?.bot_status),
				is_crawler: Boolean(payload?.is_crawler),
				connection_type: payload?.connection_type || null,
			},
		};
		if (redis) {
			await redis.set(cacheKey, JSON.stringify(normalized), 'EX', CACHE_TTL_SECONDS);
		}
		registerSuccess();
		return normalized;
	} catch (_error) {
		registerFailure();
		return {
			provider: 'ipqs',
			score: 0,
			timedOut: true,
			cached: false,
			circuitOpen: isCircuitOpen(),
			raw: null,
		};
	} finally {
		clearTimeout(timeoutId);
	}
};

module.exports = {
	getIpReputation,
};
