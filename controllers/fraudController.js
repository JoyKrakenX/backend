/** @format */

const { startEmailOtpChallenge, verifyEmailOtpChallenge } = require('../services/fraud/emailOtpService');
const { logFraudDecision } = require('../services/fraud/fraudDecisionLogService');

const normalizeContextType = (value) => {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'profile' || normalized === 'complete_profile') return 'profile';
	return 'vote';
};

exports.startEmailChallenge = async (req, res) => {
	try {
		if (!req.userId || !req.userEmail) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const contextType = normalizeContextType(req.body?.contextType);
		const requestedSurveyId = String(req.body?.surveyId || '').trim();
		let surveyId = requestedSurveyId || null;
		const surveyType = req.body?.surveyType || 'unknown';
		const isTempProfileAuth = String(req.authMode || '') === 'temp_profile';

		if (isTempProfileAuth && contextType !== 'profile') {
			return res.status(403).json({
				ok: false,
				code: 'TEMP_TOKEN_PROFILE_ONLY',
				message: 'Le token temporaire est reserve au contexte profil.',
			});
		}
		if (contextType === 'profile') {
			if (requestedSurveyId) {
				return res.status(400).json({
					ok: false,
					code: 'PROFILE_CONTEXT_SURVEY_FORBIDDEN',
					message: 'surveyId est interdit pour le contexte profil.',
				});
			}
			surveyId = null;
		}

		const response = await startEmailOtpChallenge({
			userId: req.userId,
			userEmail: req.userEmail,
			contextType,
			surveyId,
			surveyType,
			ipHash: req?.riskIdentity?.ipHash || null,
			deviceHash: req?.riskIdentity?.deviceHash || null,
		});

		return res.status(200).json({
			ok: true,
			code: 'EMAIL_OTP_REQUIRED',
			challengeType: 'email_otp',
			challenge: {
				type: 'email_otp',
				otp: {
					challengeId: response.challengeId,
					expiresInSeconds: response.expiresInSeconds,
					startEndpoint: '/api/fraud/challenges/email/start',
					verifyEndpoint: '/api/fraud/challenges/email/verify',
				},
			},
			...response,
		});
	} catch (error) {
		const code = String(error?.code || 'OTP_START_FAILED');
		const status =
			code === 'MAIL_PROVIDER_NOT_CONFIGURED' ||
			code === 'REDIS_REQUIRED_FOR_FRAUD_OTP' ?
				503
			: 400;

		await logFraudDecision({
			event: 'otp_start',
			decision: 'blocked',
			actionType: 'otp',
			userId: req.userId,
			riskScore: 0,
			reasons: [code],
			challengeType: 'email_otp',
			meta: {
				status,
			},
		});

		return res.status(status).json({
			ok: false,
			code,
			message: 'Impossible de demarrer la verification email.',
		});
	}
};

exports.verifyEmailChallenge = async (req, res) => {
	try {
		if (!req.userId) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const challengeId = String(req.body?.challengeId || '').trim();
		const code = String(req.body?.code || '').trim();
		if (!challengeId || !code) {
			return res.status(400).json({
				ok: false,
				code: 'OTP_PAYLOAD_INVALID',
				message: 'challengeId et code sont requis.',
			});
		}

		const response = await verifyEmailOtpChallenge({
			userId: req.userId,
			challengeId,
			code,
		});

		return res.status(200).json({
			ok: true,
			code: 'EMAIL_OTP_VERIFIED',
			challengeType: 'email_otp',
			challenge: {
				type: 'email_otp',
				otp: {
					challengeToken: response.challengeToken,
				},
			},
			...response,
		});
	} catch (error) {
		const code = String(error?.code || 'OTP_VERIFY_FAILED');
		const status =
			code === 'OTP_CHALLENGE_EXPIRED' ? 410
			: code === 'OTP_CHALLENGE_FORBIDDEN' ? 403
			: code === 'OTP_MAX_ATTEMPTS_REACHED' ? 429
			: 400;

		return res.status(status).json({
			ok: false,
			code,
			message: 'Verification OTP invalide.',
		});
	}
};
