/** @format */

const crypto = require('crypto');

const { getRedisClient } = require('../redisService');
const { sendEmail, canSendEmails } = require('../emailService');
const { FRAUD_CONFIG } = require('../../utils/fraudConfig');
const { signFraudChallengeToken } = require('./challengeTokenService');
const { logFraudDecision } = require('./fraudDecisionLogService');

const OTP_KEY_PREFIX = 'fraud:otp:challenge';

const buildOtpCode = () =>
	String(Math.floor(100000 + Math.random() * 900000)).padStart(6, '0');

const hashOtpCode = (code) => {
	const secret =
		String(process.env.FRAUD_OTP_HASH_SECRET || process.env.FRAUD_DEVICE_HASH_SECRET || '') ||
		'otp-fallback-secret';
	return crypto
		.createHmac('sha256', secret)
		.update(String(code || ''))
		.digest('hex');
};

const resolveRedis = async () => {
	const redis = await getRedisClient();
	if (!redis) {
		const error = new Error('REDIS_REQUIRED_FOR_FRAUD_OTP');
		error.code = 'REDIS_REQUIRED_FOR_FRAUD_OTP';
		throw error;
	}
	return redis;
};

const startEmailOtpChallenge = async ({
	userId,
	userEmail,
	contextType,
	surveyId = null,
	surveyType = 'unknown',
	ipHash = null,
	deviceHash = null,
}) => {
	if (!FRAUD_CONFIG.otpEnabled) {
		const error = new Error('OTP_DISABLED');
		error.code = 'OTP_DISABLED';
		throw error;
	}

	if (!canSendEmails()) {
		const error = new Error('MAIL_PROVIDER_NOT_CONFIGURED');
		error.code = 'MAIL_PROVIDER_NOT_CONFIGURED';
		throw error;
	}

	const redis = await resolveRedis();
	const challengeId = crypto.randomUUID();
	const code = buildOtpCode();
	const record = {
		userId: String(userId),
		userEmail: String(userEmail || '').trim().toLowerCase(),
		contextType: String(contextType || 'vote'),
		surveyId: surveyId ? String(surveyId) : null,
		surveyType: String(surveyType || 'unknown'),
		codeHash: hashOtpCode(code),
		attempts: 0,
		createdAt: new Date().toISOString(),
	};

	const redisKey = `${OTP_KEY_PREFIX}:${challengeId}`;
	await redis.set(
		redisKey,
		JSON.stringify(record),
		'EX',
		Math.max(60, Number(FRAUD_CONFIG.emailOtpTtlSeconds || 600)),
	);

	await sendEmail({
		to: record.userEmail,
		subject: 'Verification de securite Community',
		html: `<p>Code de verification: <strong>${code}</strong></p><p>Ce code expire dans ${Math.round(
			Number(FRAUD_CONFIG.emailOtpTtlSeconds || 600) / 60,
		)} minutes.</p>`,
		text: `Code de verification: ${code}. Expire dans ${Math.round(
			Number(FRAUD_CONFIG.emailOtpTtlSeconds || 600) / 60,
		)} minutes.`,
		requireConfigured: true,
	});

	await logFraudDecision({
		event: 'otp_start',
		decision: 'email_otp_required',
		actionType: 'otp',
		userId,
		surveyId,
		surveyType,
		ipHash,
		deviceHash,
		riskScore: 0,
		reasons: ['EMAIL_OTP_CHALLENGE_STARTED'],
		challengeType: 'email_otp',
		meta: {
			contextType: record.contextType,
			challengeId,
		},
	});

	return {
		challengeId,
		expiresInSeconds: Math.max(60, Number(FRAUD_CONFIG.emailOtpTtlSeconds || 600)),
	};
};

const verifyEmailOtpChallenge = async ({ userId, challengeId, code }) => {
	const redis = await resolveRedis();
	const redisKey = `${OTP_KEY_PREFIX}:${String(challengeId || '').trim()}`;
	const storedRaw = await redis.get(redisKey);
	if (!storedRaw) {
		const error = new Error('OTP_CHALLENGE_EXPIRED');
		error.code = 'OTP_CHALLENGE_EXPIRED';
		throw error;
	}

	const stored = JSON.parse(storedRaw);
	if (String(stored.userId || '') !== String(userId || '')) {
		const error = new Error('OTP_CHALLENGE_FORBIDDEN');
		error.code = 'OTP_CHALLENGE_FORBIDDEN';
		throw error;
	}

	const attempts = Number(stored.attempts || 0);
	if (attempts >= Number(FRAUD_CONFIG.emailOtpMaxAttempts || 5)) {
		await redis.del(redisKey);
		const error = new Error('OTP_MAX_ATTEMPTS_REACHED');
		error.code = 'OTP_MAX_ATTEMPTS_REACHED';
		throw error;
	}

	const submittedHash = hashOtpCode(String(code || '').trim());
	if (!submittedHash || submittedHash !== String(stored.codeHash || '')) {
		stored.attempts = attempts + 1;
		const ttl = await redis.ttl(redisKey);
		if (ttl > 0) {
			await redis.set(redisKey, JSON.stringify(stored), 'EX', ttl);
		}
		const error = new Error('OTP_INVALID_CODE');
		error.code = 'OTP_INVALID_CODE';
		throw error;
	}

	await redis.del(redisKey);
	const challengeToken = signFraudChallengeToken({
		userId,
		contextType: stored.contextType,
		surveyId: stored.surveyId,
		surveyType: stored.surveyType,
		challengeId,
	});

	await logFraudDecision({
		event: 'otp_verify',
		decision: 'accepted',
		actionType: 'otp',
		userId,
		surveyId: stored.surveyId,
		surveyType: stored.surveyType,
		riskScore: 0,
		reasons: ['EMAIL_OTP_VERIFIED'],
		challengeType: 'email_otp',
		meta: {
			challengeId,
			contextType: stored.contextType,
		},
	});

	return {
		challengeToken,
		contextType: stored.contextType,
		surveyId: stored.surveyId,
		surveyType: stored.surveyType,
	};
};

module.exports = {
	startEmailOtpChallenge,
	verifyEmailOtpChallenge,
};
