/** @format */

const parseBoolean = (value, fallback = false) => {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
};

const parseNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const FRAUD_VERSION = 1;

const FRAUD_STATUSES = Object.freeze({
	ACCEPTED: 'accepted',
	QUARANTINED: 'quarantined',
	RELEASED: 'released',
	CONFIRMED_FRAUD: 'confirmed_fraud',
});

const CLEAN_FRAUD_STATUSES = Object.freeze([
	FRAUD_STATUSES.ACCEPTED,
	FRAUD_STATUSES.RELEASED,
]);

const RAW_FRAUD_STATUSES = Object.freeze([
	FRAUD_STATUSES.ACCEPTED,
	FRAUD_STATUSES.QUARANTINED,
	FRAUD_STATUSES.RELEASED,
	FRAUD_STATUSES.CONFIRMED_FRAUD,
]);

const FRAUD_CONFIG = Object.freeze({
	enabled: parseBoolean(process.env.FRAUD_ENGINE_ENABLED, true),
	quarantineEnabled: parseBoolean(process.env.FRAUD_QUARANTINE_ENABLED, true),
	otpEnabled: parseBoolean(process.env.FRAUD_OTP_ENABLED, true),
	turnstileEnabled: parseBoolean(process.env.FRAUD_TURNSTILE_ENABLED, true),
	ipqsEnabled: parseBoolean(process.env.FRAUD_IPQS_ENABLED, true),
	retentionDays: Math.max(7, parseNumber(process.env.FRAUD_RETENTION_DAYS, 90)),
	ipqsTimeoutMs: Math.max(300, parseNumber(process.env.IPQS_TIMEOUT_MS, 1200)),
	turnstileTimeoutMs: Math.max(300, parseNumber(process.env.TURNSTILE_TIMEOUT_MS, 1500)),
	quarantineMin: clamp(parseNumber(process.env.FRAUD_SCORE_QUARANTINE_MIN, 35), 0, 100),
	otpMin: clamp(parseNumber(process.env.FRAUD_SCORE_OTP_MIN, 65), 0, 100),
	blockMin: clamp(parseNumber(process.env.FRAUD_SCORE_BLOCK_MIN, 85), 0, 100),
	emailOtpTtlSeconds: Math.max(
		60,
		parseNumber(process.env.FRAUD_EMAIL_OTP_TTL_SECONDS, 600),
	),
	emailOtpMaxAttempts: Math.max(
		1,
		parseNumber(process.env.FRAUD_EMAIL_OTP_MAX_ATTEMPTS, 5),
	),
	challengeTokenExpiresIn: String(
		process.env.FRAUD_CHALLENGE_TOKEN_EXPIRES_IN || '15m',
	).trim(),
});

module.exports = {
	parseBoolean,
	parseNumber,
	clamp,
	FRAUD_VERSION,
	FRAUD_CONFIG,
	FRAUD_STATUSES,
	CLEAN_FRAUD_STATUSES,
	RAW_FRAUD_STATUSES,
};
