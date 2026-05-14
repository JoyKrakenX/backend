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

const loadService = ({ traces = [], accountLinks = [], linkedTrace = null } = {}) => {
	const previousSecret = process.env.MACHINE_SIGNATURE_HASH_SECRET;
	process.env.MACHINE_SIGNATURE_HASH_SECRET = 'machine-signature-test-secret';

	const findResult = {
		select: () => findResult,
		sort: () => findResult,
		limit: () => findResult,
		lean: async () => traces,
	};
	const accountLinkFindResult = {
		select: () => accountLinkFindResult,
		sort: () => accountLinkFindResult,
		limit: () => accountLinkFindResult,
		lean: async () => accountLinks,
	};

	const cleanups = [
		setMockModule('models/DeviceAccountLink.js', {
			find: () => accountLinkFindResult,
			updateOne: async () => ({ acknowledged: true, modifiedCount: 1, upsertedCount: 0 }),
			DEVICE_ACCOUNT_LINK_KINDS: {
				MACHINE_SIGNATURE: 'machine_signature',
				MACHINE_STABLE_PROFILE: 'machine_stable_profile',
				RETROACTIVE_REVIEW: 'retroactive_review',
			},
		}),
		setMockModule('models/DeviceTrace.js', {
			find: () => findResult,
			findOne: () => ({
				select: () => ({
					sort: () => ({
						lean: async () => linkedTrace,
					}),
				}),
			}),
			create: async (payload) => payload,
			MACHINE_TRACE_DECISIONS: {
				ACCEPTED: 'accepted',
				QUARANTINED: 'quarantined',
				BLOCKED: 'blocked',
			},
		}),
	];

	delete require.cache[resolveBackendModule('services/fraud/machineSignatureService.js')];
	const service = require(path.join(
		backendRoot,
		'services/fraud/machineSignatureService.js',
	));

	return {
		service,
		cleanup: () => {
			for (const cleanup of cleanups.reverse()) cleanup();
			if (typeof previousSecret === 'undefined') delete process.env.MACHINE_SIGNATURE_HASH_SECRET;
			else process.env.MACHINE_SIGNATURE_HASH_SECRET = previousSecret;
			delete require.cache[resolveBackendModule('services/fraud/machineSignatureService.js')];
		},
	};
};

const makeReq = () => ({
	body: {
		deviceIntegrity: {
			publicKey: { x: 'public-key-x' },
			fingerprint: {
				visitorId: 'visitor-1234567890',
				signals: {
					screen: {
						width: 1920,
						height: 1080,
						availWidth: 1920,
						availHeight: 1040,
						colorDepth: 24,
						pixelRatio: 1,
					},
					timezone: 'Africa/Porto-Novo',
					timezoneOffset: -60,
					languages: ['fr-FR', 'fr'],
					platform: 'Win32',
					maxTouchPoints: 0,
					hardwareConcurrency: 8,
					deviceMemory: 8,
					uaData: {
						platform: 'Windows',
						architecture: 'x86',
						bitness: '64',
						mobile: false,
					},
					webgl: {
						vendor: 'Google Inc.',
						renderer: 'ANGLE NVIDIA RTX',
					},
				},
				components: {
					canvas: { value: 'canvas-same' },
					audio: { value: 124.55 },
					colorDepth: { value: 24 },
					fonts: { value: ['Arial', 'Roboto', 'Segoe UI'] },
					languages: { value: ['fr-FR', 'fr'] },
					math: { value: { acos: 1.447 } },
					platform: { value: 'Win32' },
					plugins: { value: ['PDF Viewer'] },
					screenFrame: { value: [0, 0, 40, 0] },
					screenResolution: { value: [1920, 1080] },
					timezone: { value: 'Africa/Porto-Novo' },
					touchSupport: { value: { maxTouchPoints: 0, touchEvent: false } },
					vendor: { value: 'Google Inc.' },
					vendorFlavors: { value: ['chrome'] },
					webGlBasics: { value: { renderer: 'ANGLE NVIDIA RTX' } },
					fontPreferences: { value: { sans: 141.2 } },
				},
			},
		},
	},
	riskIdentity: {
		ipHash: 'ip-hash',
		deviceHash: 'cookie-device-hash',
		ua: {
			os: 'Windows',
			browser: 'Chrome',
			device: 'desktop',
		},
	},
});

const makeFraudDecision = (raw = {}) => ({
	providerMeta: {
		ipReputation: {
			provider: 'ipqs',
			score: Number(raw.fraud_score || 0),
			raw,
		},
	},
});

test('machine signature blocks strong cross-browser match', async () => {
	const { service, cleanup } = loadService();
	try {
		const firstSignature = service.buildMachineSignature({
			req: makeReq(),
			fraudDecision: makeFraudDecision(),
		});
		cleanup();

		const loaded = loadService({
			traces: [
				{
					_id: 'trace-1',
					userId: '507f1f77bcf86cd799439099',
					hardwareCoreHash: firstSignature.hardwareCoreHash,
					renderingHash: firstSignature.renderingHash,
					environmentHash: firstSignature.environmentHash,
					networkContextHash: firstSignature.networkContextHash,
					browserProofHash: 'different-browser-proof',
					componentHashes: firstSignature.componentHashes,
				},
			],
		});
		try {
			const result = await loaded.service.evaluateMachineSignatureVote({
				req: makeReq(),
				userId: '507f1f77bcf86cd799439011',
				surveyId: '507f1f77bcf86cd799439012',
				surveyType: 'binary',
				fraudDecision: makeFraudDecision(),
			});
			assert.equal(result.ok, false);
			assert.equal(result.code, 'DEVICE_MACHINE_ALREADY_USED');
			assert.ok(result.similarityScore >= 92);
		} finally {
			loaded.cleanup();
		}
	} finally {
		try {
			cleanup();
		} catch (_error) {}
	}
});

test('machine signature does not block same IP without hardware/rendering match', async () => {
	const { service, cleanup } = loadService({
		traces: [
			{
				_id: 'trace-1',
				userId: '507f1f77bcf86cd799439099',
				hardwareCoreHash: 'other-hardware',
				renderingHash: 'other-rendering',
				environmentHash: 'other-environment',
				networkContextHash: 'same-network',
				browserProofHash: 'other-browser',
				componentHashes: {},
			},
		],
	});
	try {
		const result = await service.evaluateMachineSignatureVote({
			req: makeReq(),
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
			fraudDecision: makeFraudDecision(),
		});
		assert.equal(result.ok, true);
		assert.equal(result.decision, 'accepted');
	} finally {
		cleanup();
	}
});

test('machine signature blocks mobile cross-browser stable network profile', async () => {
	const { service, cleanup } = loadService();
	try {
		const firstSignature = service.buildMachineSignature({
			req: makeReq(),
			fraudDecision: makeFraudDecision(),
		});
		const stableComponentHashes = [
			'colorDepth',
			'fonts',
			'languages',
			'math',
			'platform',
			'plugins',
			'screenFrame',
			'screenResolution',
			'timezone',
			'touchSupport',
			'vendor',
		].reduce((acc, name) => {
			if (firstSignature.componentHashes[name]) acc[name] = firstSignature.componentHashes[name];
			return acc;
		}, {});
		cleanup();

		const loaded = loadService({
			traces: [
				{
					_id: 'trace-1',
					userId: '507f1f77bcf86cd799439099',
					hardwareCoreHash: 'brave-changed-hardware',
					renderingHash: 'brave-changed-rendering',
					environmentHash: firstSignature.environmentHash,
					networkContextHash: firstSignature.networkContextHash,
					browserProofHash: 'different-browser-proof',
					componentHashes: stableComponentHashes,
				},
			],
		});
		try {
			const result = await loaded.service.evaluateMachineSignatureVote({
				req: makeReq(),
				userId: '507f1f77bcf86cd799439011',
				surveyId: '507f1f77bcf86cd799439012',
				surveyType: 'binary_flash',
				fraudDecision: makeFraudDecision(),
			});
			assert.equal(result.ok, false);
			assert.equal(result.code, 'DEVICE_MACHINE_ALREADY_USED');
			assert.ok(result.similarityScore >= 92);
			assert.ok(result.matchedFamilies.includes('stable:network_profile'));
		} finally {
			loaded.cleanup();
		}
	} finally {
		try {
			cleanup();
		} catch (_error) {}
	}
});

test('machine signature creates an atomic stable network lock candidate', async () => {
	const { service, cleanup } = loadService();
	try {
		const signature = service.buildMachineSignature({
			req: makeReq(),
			fraudDecision: makeFraudDecision(),
		});
		const candidates = service.buildMachineLockCandidates(signature);
		const stableLock = candidates.find((candidate) => candidate.kind === 'machine_stable_network');
		assert.ok(stableLock);
		assert.equal(stableLock.confidence, 96);
		assert.ok(stableLock.meta.componentCount >= 8);
		assert.ok(
			candidates.some((candidate) => candidate.kind === 'machine_stable_variant_network'),
		);
		assert.ok(
			candidates.some((candidate) => candidate.kind === 'machine_stable_variant_hardware'),
		);
	} finally {
		cleanup();
	}
});

test('machine signature blocks a linked account that already voted on the survey', async () => {
	const { service, cleanup } = loadService({
		accountLinks: [
			{
				userA: '507f1f77bcf86cd799439011',
				userB: '507f1f77bcf86cd799439099',
				confidence: 96,
				matchedFamilies: ['stable:network_profile'],
				linkKind: 'machine_stable_profile',
				lastSeenAt: new Date(),
			},
		],
		linkedTrace: {
			_id: 'trace-linked',
			userId: '507f1f77bcf86cd799439099',
			opinionId: 'opinion-linked',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
			decision: 'accepted',
		},
	});
	try {
		const result = await service.evaluateMachineSignatureVote({
			req: makeReq(),
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
			fraudDecision: makeFraudDecision(),
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, 'DEVICE_MACHINE_ALREADY_USED');
		assert.ok(result.matchedFamilies.includes('account_link'));
		assert.ok(result.similarityScore >= 96);
	} finally {
		cleanup();
	}
});

test('machine signature blocks strong VPN/proxy signals', async () => {
	const { service, cleanup } = loadService();
	try {
		const result = await service.evaluateMachineSignatureVote({
			req: makeReq(),
			userId: '507f1f77bcf86cd799439011',
			surveyId: '507f1f77bcf86cd799439012',
			surveyType: 'binary',
			fraudDecision: makeFraudDecision({
				fraud_score: 90,
				vpn: true,
			}),
		});
		assert.equal(result.ok, false);
		assert.equal(result.code, 'DEVICE_VPN_BLOCKED');
	} finally {
		cleanup();
	}
});
