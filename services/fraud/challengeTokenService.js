/** @format */

const jwt = require('jsonwebtoken');

const { FRAUD_CONFIG } = require('../../utils/fraudConfig');

const resolveChallengeSecret = () =>
	String(
		process.env.FRAUD_CHALLENGE_SECRET ||
			process.env.JWT_TEMP_SECRET ||
			process.env.JWT_SECRET ||
			'',
	).trim();

const signFraudChallengeToken = ({
	userId,
	contextType,
	surveyId = null,
	surveyType = 'unknown',
	challengeId,
}) => {
	const secret = resolveChallengeSecret();
	if (!secret) {
		throw new Error('FRAUD_CHALLENGE_SECRET_MISSING');
	}

	return jwt.sign(
		{
			type: 'fraud_challenge',
			userId: String(userId),
			contextType: String(contextType),
			surveyId: surveyId ? String(surveyId) : null,
			surveyType: String(surveyType || 'unknown'),
			challengeId: String(challengeId || ''),
			verifiedAt: new Date().toISOString(),
		},
		secret,
		{ expiresIn: FRAUD_CONFIG.challengeTokenExpiresIn },
	);
};

const verifyFraudChallengeToken = (token) => {
	const normalized = String(token || '').trim();
	if (!normalized) return null;
	const secret = resolveChallengeSecret();
	if (!secret) return null;

	try {
		const payload = jwt.verify(normalized, secret);
		if (payload?.type !== 'fraud_challenge') return null;
		return payload;
	} catch (_error) {
		return null;
	}
};

module.exports = {
	signFraudChallengeToken,
	verifyFraudChallengeToken,
};
