/** @format */

const crypto = require('crypto');
const { UAParser } = require('ua-parser-js');

const { FRAUD_CONFIG } = require('../utils/fraudConfig');

const DEVICE_COOKIE_NAME = 'sa_device';
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const resolveCookieSecret = () =>
	String(
		process.env.FRAUD_DEVICE_COOKIE_SECRET ||
			process.env.FRAUD_DEVICE_HASH_SECRET ||
			'',
	).trim();

const normalizeIp = (value) => {
	const raw = String(value || '').trim();
	if (!raw) return null;
	const first = raw.split(',')[0].trim();
	if (!first) return null;
	return first.replace(/^::ffff:/i, '');
};

const safeHmac = (secret, value) => {
	const normalized = String(value || '').trim();
	if (!secret || !normalized) return null;
	return crypto
		.createHmac('sha256', String(secret))
		.update(normalized)
		.digest('hex');
};

const buildDeviceId = () => crypto.randomUUID();

module.exports = (req, res, next) => {
	const cookieSecret = resolveCookieSecret();
	const hasCookieSecret = Boolean(cookieSecret);
	const forwarded = req.headers['x-forwarded-for'];
	const ip = normalizeIp(forwarded || req.ip || req.socket?.remoteAddress || null);

	const signedCookieValue = String(req.signedCookies?.[DEVICE_COOKIE_NAME] || '').trim();
	const unsignedCookieValue = String(req.cookies?.[DEVICE_COOKIE_NAME] || '').trim();
	let deviceId = hasCookieSecret ? signedCookieValue : unsignedCookieValue;
	let shouldPersistDeviceCookie = false;

	if (hasCookieSecret && !deviceId && unsignedCookieValue) {
		// Rotate unsigned/invalid cookie values when signature is expected.
		deviceId = buildDeviceId();
		shouldPersistDeviceCookie = true;
	}

	if (!deviceId) {
		const headerDevice = String(req.headers['x-device-id'] || '').trim();
		deviceId = headerDevice || buildDeviceId();
		shouldPersistDeviceCookie = true;
	}

	if (shouldPersistDeviceCookie) {
		res.cookie(DEVICE_COOKIE_NAME, deviceId, {
			maxAge: DEVICE_COOKIE_MAX_AGE_MS,
			httpOnly: true,
			sameSite: 'lax',
			secure: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
			path: '/',
			signed: hasCookieSecret,
		});
	}

	const parser = new UAParser(req.headers['user-agent'] || '');
	const parsedUa = parser.getResult();

	const ipHash = safeHmac(process.env.FRAUD_IP_HASH_SECRET, ip);
	const deviceHash = safeHmac(process.env.FRAUD_DEVICE_HASH_SECRET, deviceId);

	req.riskIdentity = {
		ip,
		ipHash,
		deviceId,
		deviceHash,
		userAgent: String(req.headers['user-agent'] || ''),
		ua: {
			browser: parsedUa?.browser?.name || null,
			os: parsedUa?.os?.name || null,
			device: parsedUa?.device?.type || 'desktop',
		},
		challengeToken:
			String(req.headers['x-fraud-challenge-token'] || '').trim() || null,
		enabled: FRAUD_CONFIG.enabled,
		deviceCookieSigned: hasCookieSecret,
	};

	next();
};
