/** @format */

const crypto = require('crypto');

const User = require('../../models/User');
const Opinion = require('../../models/Opinion');
const Opinion2 = require('../../models/Opinion_2');
const OpinionFlash = require('../../models/Opinion_Flash');
const Opinion2Flash = require('../../models/Opinion_2_Flash');
const {
	FRAUD_CONFIG,
	FRAUD_STATUSES,
	FRAUD_VERSION,
	clamp,
} = require('../../utils/fraudConfig');
const { getRedisClient } = require('../redisService');
const { getIpReputation } = require('./ipReputationService');
const { verifyTurnstile } = require('./turnstileService');
const { verifyFraudChallengeToken } = require('./challengeTokenService');
const { logFraudDecision } = require('./fraudDecisionLogService');

const OPINION_MODELS = [Opinion, Opinion2, OpinionFlash, Opinion2Flash];

const normalizeReason = (value) =>
	String(value || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.slice(0, 500);

const hashReason = (value) => {
	const normalized = normalizeReason(value);
	if (!normalized) return null;
	const secret =
		String(process.env.FRAUD_REASON_HASH_SECRET || process.env.FRAUD_DEVICE_HASH_SECRET || '') ||
		'reason-secret';
	return crypto
		.createHmac('sha256', secret)
		.update(normalized)
		.digest('hex');
};

const countAcrossModels = async (filter) => {
	const counts = await Promise.all(
		OPINION_MODELS.map((Model) => Model.countDocuments(filter)),
	);
	return counts.reduce((sum, value) => sum + Number(value || 0), 0);
};

const distinctUsersAcrossModels = async (filter) => {
	const chunks = await Promise.all(
		OPINION_MODELS.map((Model) => Model.distinct('userId', filter)),
	);
	const set = new Set();
	chunks.forEach((entries) => {
		(entries || []).forEach((entry) => {
			set.add(String(entry));
		});
	});
	return set;
};

const getGraphRiskScore = async (userId) => {
	if (!userId) return 0;
	const redis = await getRedisClient();
	if (!redis) return 0;
	const raw = await redis.get(`fraud:graph:user:${String(userId)}`);
	const parsed = Number(raw || 0);
	if (!Number.isFinite(parsed)) return 0;
	return clamp(parsed, 0, 100);
};

const computeFeatures = async ({ user, surveyId, reasonHash, identity }) => {
	const now = Date.now();
	const window24h = new Date(now - 24 * 60 * 60 * 1000);
	const window5m = new Date(now - 5 * 60 * 1000);
	const window1h = new Date(now - 60 * 60 * 1000);

	const accountCreatedAt = new Date(user?.createdAt || now);
	const accountAgeHours = Math.max(0, (now - accountCreatedAt.getTime()) / (60 * 60 * 1000));
	const fAccountAge = clamp((72 - accountAgeHours) / 72, 0, 1);

	const ipReputation = await getIpReputation({
		ip: identity?.ip,
		ipHash: identity?.ipHash,
	});
	const fIpReputation = clamp(Number(ipReputation.score || 0) / 100, 0, 1);

	const ipUserFanoutSet = identity?.ipHash
		? await distinctUsersAcrossModels({
				ipHash: identity.ipHash,
				createdAt: { $gte: window24h },
		  })
		: new Set();
	const fIpFanout = clamp(ipUserFanoutSet.size / 8, 0, 1);

	const deviceUserFanoutSet = identity?.deviceHash
		? await distinctUsersAcrossModels({
				deviceHash: identity.deviceHash,
				createdAt: { $gte: window24h },
		  })
		: new Set();
	const fDeviceFanout = clamp(deviceUserFanoutSet.size / 5, 0, 1);

	let velocityFilter = { createdAt: { $gte: window5m } };
	if (identity?.ipHash || identity?.deviceHash) {
		velocityFilter = {
			...velocityFilter,
			$or: [
				identity?.ipHash ? { ipHash: identity.ipHash } : null,
				identity?.deviceHash ? { deviceHash: identity.deviceHash } : null,
			].filter(Boolean),
		};
	}
	const voteVelocity = await countAcrossModels(velocityFilter);
	const fVoteVelocity = clamp(Number(voteVelocity || 0) / 6, 0, 1);

	const reasonReuseCount =
		surveyId && reasonHash
			? await countAcrossModels({
					surveyId,
					reasonHash,
					createdAt: { $gte: window1h },
			  })
			: 0;
	const fReasonReuse = clamp(Math.max(0, Number(reasonReuseCount || 0) - 1) / 5, 0, 1);

	const graphRiskScore = await getGraphRiskScore(user?._id || user?.id);
	const fGraphRisk = clamp(graphRiskScore / 100, 0, 1);

	return {
		fAccountAge,
		fIpReputation,
		fIpFanout,
		fDeviceFanout,
		fVoteVelocity,
		fReasonReuse,
		fGraphRisk,
		ipReputation,
		accountAgeHours,
		voteVelocity,
		reasonReuseCount,
		ipFanoutCount: ipUserFanoutSet.size,
		deviceFanoutCount: deviceUserFanoutSet.size,
		graphRiskScore,
	};
};

const computeRiskScore = (features) => {
	const weighted =
		0.18 * features.fAccountAge +
		0.22 * features.fIpReputation +
		0.16 * features.fIpFanout +
		0.16 * features.fDeviceFanout +
		0.12 * features.fVoteVelocity +
		0.1 * features.fReasonReuse +
		0.06 * features.fGraphRisk;
	return Math.round(clamp(weighted, 0, 1) * 100);
};

const buildReasons = ({ score, features }) => {
	const reasons = [];
	if (score >= FRAUD_CONFIG.quarantineMin) reasons.push('RISK_SCORE_ABOVE_QUARANTINE');
	if (features.fAccountAge >= 0.7) reasons.push('ACCOUNT_TOO_NEW');
	if (features.fIpReputation >= 0.6) reasons.push('IP_REPUTATION_HIGH_RISK');
	if (features.fIpFanout >= 0.5) reasons.push('IP_ACCOUNT_FANOUT_HIGH');
	if (features.fDeviceFanout >= 0.5) reasons.push('DEVICE_ACCOUNT_FANOUT_HIGH');
	if (features.fVoteVelocity >= 0.5) reasons.push('VOTE_VELOCITY_SPIKE');
	if (features.fReasonReuse >= 0.5) reasons.push('REASON_REUSE_SPIKE');
	if (features.fGraphRisk >= 0.6) reasons.push('GRAPH_COMPONENT_RISK_HIGH');
	if (features.ipReputation?.timedOut) reasons.push('IP_REPUTATION_TIMEOUT');
	return reasons;
};

const isChallengeTokenValid = ({
	challengeToken,
	expectedUserId,
	expectedContext,
	expectedSurveyId,
}) => {
	if (!challengeToken) return false;
	const payload = verifyFraudChallengeToken(challengeToken);
	if (!payload) return false;
	if (String(payload.userId || '') !== String(expectedUserId || '')) return false;
	if (String(payload.contextType || '') !== String(expectedContext || '')) return false;
	if (expectedSurveyId && String(payload.surveyId || '') !== String(expectedSurveyId || '')) {
		return false;
	}
	return true;
};

const buildChallengePayload = ({ code, message, challengeType, surveyId, surveyType }) => {
	const turnstileSiteKey = String(process.env.TURNSTILE_SITE_KEY || '').trim() || null;
	const challenge = {
		type: challengeType,
		turnstile:
			challengeType === 'turnstile' ?
				{
					siteKey: turnstileSiteKey,
					tokenField: 'turnstileToken',
				}
			:	null,
		otp:
			challengeType === 'email_otp' ?
				{
					startEndpoint: '/api/fraud/challenges/email/start',
					verifyEndpoint: '/api/fraud/challenges/email/verify',
				}
			:	null,
	};

	return {
		kind: 'challenge',
		httpStatus: 428,
		code,
		message,
		challengeType,
		challenge,
		surveyId: surveyId ? String(surveyId) : null,
		surveyType: String(surveyType || 'unknown'),
		turnstile: challenge.turnstile,
		otp: challenge.otp,
	};
};

const evaluateFraudDecision = async ({
	actionType,
	userId,
	surveyId = null,
	surveyType = 'unknown',
	reason = '',
	identity = {},
	turnstileToken = null,
	challengeToken = null,
	opinionModel = null,
}) => {
	const user = await User.findById(userId).select('_id createdAt email').lean();
	if (!user) {
		return {
			kind: 'decision',
			httpStatus: 404,
			decision: 'blocked',
			code: 'USER_NOT_FOUND',
			message: 'Utilisateur introuvable.',
			riskScore: 100,
			reasons: ['USER_NOT_FOUND'],
		};
	}

	if (!FRAUD_CONFIG.enabled) {
		return {
			kind: 'decision',
			httpStatus: 200,
			decision: 'accepted',
			code: 'FRAUD_ENGINE_DISABLED',
			message: 'Fraud engine disabled.',
			riskScore: 0,
			reasons: [],
			reasonHash: hashReason(reason),
			captchaVerified: false,
			providerMeta: { ipReputation: null },
			metrics: {},
		};
	}

	const reasonHash = hashReason(reason);
	const features = await computeFeatures({
		user,
		surveyId,
		reasonHash,
		identity,
	});
	const score = computeRiskScore(features);
	const reasons = buildReasons({ score, features });
	const turnstileSiteKey = String(process.env.TURNSTILE_SITE_KEY || '').trim();
	const turnstileSecretKey = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
	const turnstileGateEnabled =
		FRAUD_CONFIG.turnstileEnabled && Boolean(turnstileSiteKey && turnstileSecretKey);

	const contextType = actionType === 'complete_profile' ? 'profile' : 'vote';
	const challengeValid = isChallengeTokenValid({
		challengeToken,
		expectedUserId: user._id,
		expectedContext: contextType,
		expectedSurveyId: surveyId,
	});

	if (turnstileGateEnabled && score >= FRAUD_CONFIG.quarantineMin && !challengeValid) {
		if (!turnstileToken) {
			const challenge = buildChallengePayload({
				code: 'TURNSTILE_REQUIRED',
				message: 'Verification CAPTCHA requise.',
				challengeType: 'turnstile',
				surveyId,
				surveyType,
			});
			await logFraudDecision({
				event: actionType === 'vote' ? 'vote_decision' : 'profile_decision',
				decision: 'turnstile_required',
				actionType,
				userId,
				surveyId,
				surveyType,
				opinionModel,
				ipHash: identity?.ipHash,
				deviceHash: identity?.deviceHash,
				riskScore: score,
				reasons,
				challengeType: 'turnstile',
				metrics: features,
				providerMeta: { ipReputation: features.ipReputation },
			});
			return challenge;
		}

		const turnstile = await verifyTurnstile({
			token: turnstileToken,
			remoteIp: identity?.ip,
		});
		if (!turnstile.ok) {
			if (!turnstile.timeout) {
				const challenge = buildChallengePayload({
					code: 'TURNSTILE_REQUIRED',
					message: 'Verification CAPTCHA invalide.',
					challengeType: 'turnstile',
					surveyId,
					surveyType,
				});
				await logFraudDecision({
					event: actionType === 'vote' ? 'vote_decision' : 'profile_decision',
					decision: 'turnstile_required',
					actionType,
					userId,
					surveyId,
					surveyType,
					opinionModel,
					ipHash: identity?.ipHash,
					deviceHash: identity?.deviceHash,
					riskScore: score,
					reasons: [...reasons, 'TURNSTILE_INVALID'],
					challengeType: 'turnstile',
					metrics: features,
					providerMeta: { ipReputation: features.ipReputation, turnstile },
				});
				return challenge;
			}
			reasons.push('TURNSTILE_TIMEOUT_FAIL_SAFE_QUARANTINE');
		}
	}

	let decision = 'accepted';
	let challengeType = 'none';
	let httpStatus = 200;
	let code = 'FRAUD_ACCEPTED';
	let message = 'Fraud checks passed.';

	if (score >= FRAUD_CONFIG.blockMin) {
		decision = 'blocked';
		httpStatus = 403;
		code = 'FRAUD_BLOCKED';
		message = 'Vote bloque pour risque eleve.';
	} else if (score >= FRAUD_CONFIG.otpMin && FRAUD_CONFIG.otpEnabled && !challengeValid) {
		const challenge = buildChallengePayload({
			code: 'EMAIL_OTP_REQUIRED',
			message: 'Verification email requise pour continuer.',
			challengeType: 'email_otp',
			surveyId,
			surveyType,
		});
		await logFraudDecision({
			event: actionType === 'vote' ? 'vote_decision' : 'profile_decision',
			decision: 'email_otp_required',
			actionType,
			userId,
			surveyId,
			surveyType,
			opinionModel,
			ipHash: identity?.ipHash,
			deviceHash: identity?.deviceHash,
			riskScore: score,
			reasons,
			challengeType: 'email_otp',
			metrics: features,
			providerMeta: { ipReputation: features.ipReputation },
		});
		return challenge;
	} else if (score >= FRAUD_CONFIG.quarantineMin || features.ipReputation?.timedOut) {
		decision = FRAUD_CONFIG.quarantineEnabled ? 'quarantined' : 'accepted';
		httpStatus = 200;
		challengeType = challengeValid ? 'email_otp' : 'none';
		code = decision === 'quarantined' ? 'FRAUD_QUARANTINED' : 'FRAUD_ACCEPTED';
		message =
			decision === 'quarantined'
				? 'Vote place en quarantaine pour revue.'
				: 'Vote accepte.';
	}

	await logFraudDecision({
		event: actionType === 'vote' ? 'vote_decision' : 'profile_decision',
		decision,
		actionType,
		userId,
		surveyId,
		surveyType,
		opinionModel,
		ipHash: identity?.ipHash,
		deviceHash: identity?.deviceHash,
		riskScore: score,
		reasons,
		challengeType,
		metrics: features,
		providerMeta: { ipReputation: features.ipReputation },
	});

	return {
		kind: 'decision',
		httpStatus,
		decision,
		code,
		message,
		riskScore: score,
		reasons,
		reasonHash,
		captchaVerified: Boolean(turnstileToken),
		providerMeta: {
			ipReputation: features.ipReputation,
		},
		metrics: {
			accountAgeHours: Number(features.accountAgeHours || 0),
			ipFanoutCount: Number(features.ipFanoutCount || 0),
			deviceFanoutCount: Number(features.deviceFanoutCount || 0),
			voteVelocity: Number(features.voteVelocity || 0),
			reasonReuseCount: Number(features.reasonReuseCount || 0),
			graphRiskScore: Number(features.graphRiskScore || 0),
		},
		challengeType,
	};
};

const buildOpinionFraudFields = ({ result, identity }) => {
	const isQuarantined = result?.decision === 'quarantined';
	const fraudStatus =
		isQuarantined ? FRAUD_STATUSES.QUARANTINED : FRAUD_STATUSES.ACCEPTED;

	return {
		fraudStatus,
		fraudScore: Number(result?.riskScore || 0),
		fraudReasons: Array.isArray(result?.reasons) ? result.reasons : [],
		antiFraudVersion: FRAUD_VERSION,
		ipHash: identity?.ipHash || null,
		deviceHash: identity?.deviceHash || null,
		reasonHash: result?.reasonHash || null,
		ipRiskProvider: result?.providerMeta?.ipReputation?.provider || 'none',
		ipRiskScore: Number(result?.providerMeta?.ipReputation?.score || 0),
		captchaVerified: Boolean(result?.captchaVerified),
		challengeType:
			result?.challengeType === 'email_otp' ? 'email_otp'
			: result?.captchaVerified ? 'turnstile'
			: 'none',
		reviewedBy: null,
		reviewedAt: null,
	};
};

module.exports = {
	evaluateFraudDecision,
	buildOpinionFraudFields,
	normalizeReason,
	hashReason,
};
