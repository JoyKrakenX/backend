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
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	};
};

const loadService = ({ createImpl, findOneImpl } = {}) => {
	const previousSecret = process.env.DEVICE_INTEGRITY_HASH_SECRET;
	process.env.DEVICE_INTEGRITY_HASH_SECRET = 'device-integrity-test-secret';

	const model = {
		DEVICE_LOCK_KINDS: {
			COOKIE: 'cookie',
			WEBCRYPTO: 'webcrypto',
			FINGERPRINT: 'fingerprint',
			HARDWARE: 'hardware',
			MACHINE_STABLE_NETWORK: 'machine_stable_network',
			MACHINE_STABLE_VARIANT_NETWORK: 'machine_stable_variant_network',
			MACHINE_STABLE_VARIANT_HARDWARE: 'machine_stable_variant_hardware',
		},
		DEVICE_LOCK_STATUSES: {
			PENDING: 'pending',
			COMMITTED: 'committed',
		},
		create:
			createImpl ||
			(async () => ({
				_id: 'lock-1',
			})),
		findOne: () => ({
			select: () => ({
				lean: findOneImpl || (async () => null),
			}),
		}),
		updateMany: async () => ({ modifiedCount: 1 }),
		deleteMany: async () => ({ deletedCount: 1 }),
	};

	const cleanups = [
		setMockModule('models/DeviceVoteLock.js', model),
		setMockModule('services/fraud/fraudDecisionLogService.js', {
			logFraudDecision: async () => {},
		}),
		setMockModule('services/fraud/machineSignatureService.js', {
			DEVICE_MACHINE_ALREADY_USED: 'DEVICE_MACHINE_ALREADY_USED',
			DEVICE_VPN_BLOCKED: 'DEVICE_VPN_BLOCKED',
			MACHINE_BLOCK_MESSAGE: 'Machine already used.',
			VPN_BLOCK_MESSAGE: 'VPN blocked.',
			applyMachineDecisionToFraudDecision: ({ fraudDecision }) => fraudDecision,
			buildMachineLockCandidates: () => [],
			commitDeviceTrace: async () => null,
			evaluateMachineSignatureVote: async () => ({
				ok: true,
				decision: 'accepted',
				machineSignature: null,
				matchedFamilies: [],
				similarityScore: 0,
			}),
		}),
	];

	delete require.cache[resolveBackendModule('services/fraud/deviceIntegrityService.js')];
	const service = require(path.join(
		backendRoot,
		'services/fraud/deviceIntegrityService.js',
	));

	return {
		service,
		cleanup: () => {
			for (const cleanup of cleanups.reverse()) cleanup();
			if (typeof previousSecret === 'undefined') delete process.env.DEVICE_INTEGRITY_HASH_SECRET;
			else process.env.DEVICE_INTEGRITY_HASH_SECRET = previousSecret;
			delete require.cache[resolveBackendModule('services/fraud/deviceIntegrityService.js')];
		},
	};
};

const makeReq = () => ({
	body: {},
	riskIdentity: {
		deviceHash: 'existing-cookie-device-hash',
		deviceCookieCreated: false,
		deviceCookieSigned: true,
		ipHash: 'ip-hash',
	},
});

test('reserveDeviceVote creates a strong cookie lock', async () => {
	const { service, cleanup } = loadService();
	try {
		const result = await service.reserveDeviceVote({
			req: makeReq(),
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
		});
		assert.equal(result.ok, true);
		assert.deepEqual(result.lockIds, ['lock-1']);
		assert.equal(result.candidates[0].lockKind, 'cookie');
		assert.equal(result.candidates[0].confidence, 100);
	} finally {
		cleanup();
	}
});

test('reserveDeviceVote blocks another account on the same device lock', async () => {
	const duplicateError = new Error('duplicate');
	duplicateError.code = 11000;
	const { service, cleanup } = loadService({
		createImpl: async () => {
			throw duplicateError;
		},
		findOneImpl: async () => ({
			_id: 'existing-lock',
			firstUserId: '507f1f77bcf86cd799439099',
			lockKind: 'cookie',
			confidence: 100,
			status: 'committed',
		}),
	});
	try {
		const result = await service.reserveDeviceVote({
			req: makeReq(),
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, 'DEVICE_VOTE_ALREADY_USED');
		assert.equal(result.httpStatus, 403);
	} finally {
		cleanup();
	}
});

test('reserveDeviceVote refuses sessions without a reliable device signal', async () => {
	const { service, cleanup } = loadService();
	try {
		const result = await service.reserveDeviceVote({
			req: {
				body: {},
				riskIdentity: {
					deviceHash: 'new-cookie-not-yet-proven',
					deviceCookieCreated: true,
				},
			},
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, 'DEVICE_INTEGRITY_REQUIRED');
	} finally {
		cleanup();
	}
});
