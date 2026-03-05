/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(
	backendRoot,
	'services/fraud/challengeTokenService.js',
);
const fraudConfigPath = path.join(backendRoot, 'utils/fraudConfig.js');

const withEnv = (overrides = {}) => {
	const keys = [
		'FRAUD_CHALLENGE_SECRET',
		'JWT_TEMP_SECRET',
		'JWT_SECRET',
		'FRAUD_CHALLENGE_TOKEN_EXPIRES_IN',
	];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	Object.entries(overrides).forEach(([key, value]) => {
		process.env[key] = String(value);
	});
	return () => {
		for (const [key, value] of previous.entries()) {
			if (typeof value === 'undefined') delete process.env[key];
			else process.env[key] = value;
		}
	};
};

test('challenge token sign/verify works and rejects invalid payloads', () => {
	const restoreEnv = withEnv({
		FRAUD_CHALLENGE_SECRET: 'test-challenge-secret',
		FRAUD_CHALLENGE_TOKEN_EXPIRES_IN: '15m',
	});
	try {
		delete require.cache[fraudConfigPath];
		delete require.cache[modulePath];
		const {
			signFraudChallengeToken,
			verifyFraudChallengeToken,
		} = require(modulePath);

		const token = signFraudChallengeToken({
			userId: 'user-42',
			contextType: 'vote',
			surveyId: 'survey-42',
			surveyType: 'binary',
			challengeId: 'challenge-otp-1',
		});
		const payload = verifyFraudChallengeToken(token);
		assert.ok(payload);
		assert.equal(payload.userId, 'user-42');
		assert.equal(payload.contextType, 'vote');
		assert.equal(payload.surveyId, 'survey-42');
		assert.equal(payload.surveyType, 'binary');
		assert.equal(payload.challengeId, 'challenge-otp-1');

		assert.equal(verifyFraudChallengeToken('this-is-not-a-token'), null);

		const mismatchByContext = payload.contextType !== 'profile';
		const mismatchBySurvey = payload.surveyId !== 'survey-other';
		assert.equal(mismatchByContext, true);
		assert.equal(mismatchBySurvey, true);
	} finally {
		restoreEnv();
		delete require.cache[modulePath];
		delete require.cache[fraudConfigPath];
	}
});
