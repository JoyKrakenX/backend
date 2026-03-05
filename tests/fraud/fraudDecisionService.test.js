/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');

const resolveBackendModule = (relativePath) =>
	require.resolve(path.join(backendRoot, relativePath));

const setMockModule = (relativePath, exportsValue) => {
	const modulePath = resolveBackendModule(relativePath);
	const previous = require.cache[modulePath];
	require.cache[modulePath] = {
		id: modulePath,
		filename: modulePath,
		loaded: true,
		exports: exportsValue,
	};
	return () => {
		if (previous) {
			require.cache[modulePath] = previous;
		} else {
			delete require.cache[modulePath];
		}
	};
};

const withFraudEnv = (overrides = {}) => {
	const keys = [
		'FRAUD_ENGINE_ENABLED',
		'FRAUD_QUARANTINE_ENABLED',
		'FRAUD_OTP_ENABLED',
		'FRAUD_TURNSTILE_ENABLED',
		'FRAUD_IPQS_ENABLED',
		'FRAUD_SCORE_QUARANTINE_MIN',
		'FRAUD_SCORE_OTP_MIN',
		'FRAUD_SCORE_BLOCK_MIN',
		'TURNSTILE_SITE_KEY',
		'TURNSTILE_SECRET_KEY',
	];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));

	process.env.FRAUD_ENGINE_ENABLED = 'true';
	process.env.FRAUD_QUARANTINE_ENABLED = 'true';
	process.env.FRAUD_OTP_ENABLED = 'true';
	process.env.FRAUD_TURNSTILE_ENABLED = 'false';
	process.env.FRAUD_IPQS_ENABLED = 'true';
	process.env.FRAUD_SCORE_QUARANTINE_MIN = '35';
	process.env.FRAUD_SCORE_OTP_MIN = '65';
	process.env.FRAUD_SCORE_BLOCK_MIN = '85';
	process.env.TURNSTILE_SITE_KEY = '';
	process.env.TURNSTILE_SECRET_KEY = '';

	Object.entries(overrides).forEach(([key, value]) => {
		process.env[key] = String(value);
	});

	return () => {
		for (const [key, value] of previous.entries()) {
			if (typeof value === 'undefined') {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
};

const loadEvaluateFraudDecision = (scenario = {}, envOverrides = {}) => {
	const restoreEnv = withFraudEnv(envOverrides);
	const cleanups = [restoreEnv];

	const userId = String(scenario.userId || 'user-1');
	const surveyId = String(scenario.surveyId || 'survey-1');
	const userCreatedAt = scenario.userCreatedAt || new Date();
	const ipUsers = Array.isArray(scenario.ipUsers) ? scenario.ipUsers : [];
	const deviceUsers = Array.isArray(scenario.deviceUsers) ? scenario.deviceUsers : [];
	const voteVelocityCount = Number(scenario.voteVelocityCount || 0);
	const reasonReuseCount = Number(scenario.reasonReuseCount || 0);
	const ipReputation = {
		provider: 'ipqs',
		score: Number(scenario.ipScore || 0),
		timedOut: Boolean(scenario.ipTimedOut),
		cached: false,
		raw: null,
	};

	const makeOpinionModel = (mode) => ({
		countDocuments: async (filter = {}) => {
			if (mode !== 'primary') return 0;
			if (filter?.reasonHash) return reasonReuseCount;
			if (filter?.$or) return voteVelocityCount;
			return 0;
		},
		distinct: async (_field, filter = {}) => {
			if (mode !== 'primary') return [];
			if (filter?.ipHash) return ipUsers;
			if (filter?.deviceHash) return deviceUsers;
			return [];
		},
	});

	cleanups.push(
		setMockModule('models/User.js', {
			findById: () => ({
				select: () => ({
					lean: async () => ({
						_id: userId,
						createdAt: userCreatedAt,
						email: 'fraud-test@example.com',
					}),
				}),
			}),
		}),
	);
	cleanups.push(setMockModule('models/Opinion.js', makeOpinionModel('primary')));
	cleanups.push(setMockModule('models/Opinion_2.js', makeOpinionModel('secondary_1')));
	cleanups.push(
		setMockModule('models/Opinion_Flash.js', makeOpinionModel('secondary_2')),
	);
	cleanups.push(
		setMockModule('models/Opinion_2_Flash.js', makeOpinionModel('secondary_3')),
	);
	cleanups.push(
		setMockModule('services/redisService.js', {
			getRedisClient: async () => null,
		}),
	);
	cleanups.push(
		setMockModule('services/fraud/ipReputationService.js', {
			getIpReputation: async () => ipReputation,
		}),
	);
	cleanups.push(
		setMockModule('services/fraud/turnstileService.js', {
			verifyTurnstile: async () => ({ ok: true, code: 'TURNSTILE_OK' }),
		}),
	);
	cleanups.push(
		setMockModule('services/fraud/challengeTokenService.js', {
			verifyFraudChallengeToken: () => null,
		}),
	);
	cleanups.push(
		setMockModule('services/fraud/fraudDecisionLogService.js', {
			logFraudDecision: async () => {},
		}),
	);

	delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
	delete require.cache[resolveBackendModule('services/fraud/fraudDecisionService.js')];

	const fraudDecisionService = require(path.join(
		backendRoot,
		'services/fraud/fraudDecisionService.js',
	));

	const cleanup = () => {
		for (const restore of cleanups.reverse()) {
			try {
				restore();
			} catch (_error) {}
		}
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
		delete require.cache[resolveBackendModule('services/fraud/fraudDecisionService.js')];
	};

	return {
		evaluateFraudDecision: fraudDecisionService.evaluateFraudDecision,
		cleanup,
		defaults: {
			userId,
			surveyId,
		},
	};
};

test('evaluateFraudDecision applies score thresholds and fail-safe quarantine', async () => {
	const scenarios = [
		{
			name: 'accepted when score < 35',
			scenario: {
				userCreatedAt: new Date('2025-01-01T00:00:00.000Z'),
				ipScore: 0,
				ipUsers: [],
				deviceUsers: [],
				voteVelocityCount: 0,
				reasonReuseCount: 0,
			},
			expected: {
				kind: 'decision',
				decision: 'accepted',
				httpStatus: 200,
			},
		},
		{
			name: 'quarantined when score is between 35 and 64',
			scenario: {
				userCreatedAt: new Date(),
				ipScore: 100,
				ipUsers: [],
				deviceUsers: [],
				voteVelocityCount: 0,
				reasonReuseCount: 0,
			},
			expected: {
				kind: 'decision',
				decision: 'quarantined',
				httpStatus: 200,
			},
		},
		{
			name: 'otp challenge when score is between 65 and 84',
			scenario: {
				userCreatedAt: new Date(),
				ipScore: 100,
				ipUsers: ['ip-1', 'ip-2', 'ip-3', 'ip-4', 'ip-5', 'ip-6', 'ip-7', 'ip-8'],
				deviceUsers: ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'],
				voteVelocityCount: 0,
				reasonReuseCount: 0,
			},
			expected: {
				kind: 'challenge',
				code: 'EMAIL_OTP_REQUIRED',
				httpStatus: 428,
			},
		},
		{
			name: 'blocked when score >= 85',
			scenario: {
				userCreatedAt: new Date(),
				ipScore: 100,
				ipUsers: ['ip-1', 'ip-2', 'ip-3', 'ip-4', 'ip-5', 'ip-6', 'ip-7', 'ip-8'],
				deviceUsers: ['dev-1', 'dev-2', 'dev-3', 'dev-4', 'dev-5'],
				voteVelocityCount: 6,
				reasonReuseCount: 6,
			},
			expected: {
				kind: 'decision',
				decision: 'blocked',
				httpStatus: 403,
			},
		},
		{
			name: 'ip provider timeout triggers conservative quarantine',
			scenario: {
				userCreatedAt: new Date('2025-01-01T00:00:00.000Z'),
				ipScore: 0,
				ipTimedOut: true,
				ipUsers: [],
				deviceUsers: [],
				voteVelocityCount: 0,
				reasonReuseCount: 0,
			},
			expected: {
				kind: 'decision',
				decision: 'quarantined',
				httpStatus: 200,
			},
		},
	];

	for (const item of scenarios) {
		const { evaluateFraudDecision, cleanup, defaults } = loadEvaluateFraudDecision(
			item.scenario,
		);
		try {
			const result = await evaluateFraudDecision({
				actionType: 'vote',
				userId: defaults.userId,
				surveyId: defaults.surveyId,
				surveyType: 'binary',
				reason: 'test reason',
				identity: {
					ip: '203.0.113.10',
					ipHash: 'ip-hash',
					deviceHash: 'device-hash',
				},
			});

			assert.equal(result.kind, item.expected.kind, item.name);
			assert.equal(result.httpStatus, item.expected.httpStatus, item.name);
			if (item.expected.decision) {
				assert.equal(result.decision, item.expected.decision, item.name);
			}
			if (item.expected.code) {
				assert.equal(result.code, item.expected.code, item.name);
			}
		} finally {
			cleanup();
		}
	}
});

test('evaluateFraudDecision skips turnstile challenge when turnstile keys are missing', async () => {
	const { evaluateFraudDecision, cleanup, defaults } = loadEvaluateFraudDecision(
		{
			userCreatedAt: new Date(),
			ipScore: 100,
			ipUsers: [],
			deviceUsers: [],
			voteVelocityCount: 0,
			reasonReuseCount: 0,
		},
		{
			FRAUD_TURNSTILE_ENABLED: 'true',
			TURNSTILE_SITE_KEY: '',
			TURNSTILE_SECRET_KEY: '',
		},
	);
	try {
		const result = await evaluateFraudDecision({
			actionType: 'vote',
			userId: defaults.userId,
			surveyId: defaults.surveyId,
			surveyType: 'binary',
			reason: 'test reason',
			identity: {
				ip: '203.0.113.10',
				ipHash: 'ip-hash',
				deviceHash: 'device-hash',
			},
		});
		assert.equal(result.kind, 'decision');
		assert.equal(result.decision, 'quarantined');
		assert.equal(result.httpStatus, 200);
	} finally {
		cleanup();
	}
});
