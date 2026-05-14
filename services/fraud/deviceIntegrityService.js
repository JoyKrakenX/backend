/** @format */

const crypto = require('crypto');
const mongoose = require('mongoose');

const DeviceVoteLock = require('../../models/DeviceVoteLock');
const {
	DEVICE_LOCK_KINDS,
	DEVICE_LOCK_STATUSES,
} = require('../../models/DeviceVoteLock');
const { logFraudDecision } = require('./fraudDecisionLogService');
const {
	DEVICE_MACHINE_ALREADY_USED,
	DEVICE_VPN_BLOCKED,
	MACHINE_BLOCK_MESSAGE,
	VPN_BLOCK_MESSAGE,
	applyMachineDecisionToFraudDecision,
	buildMachineLockCandidates,
	commitDeviceTrace,
	evaluateMachineSignatureVote,
} = require('./machineSignatureService');

const DEVICE_INTEGRITY_VERSION = 'device-integrity-v2';
const DEVICE_VOTE_ALREADY_USED = 'DEVICE_VOTE_ALREADY_USED';
const DEVICE_INTEGRITY_REQUIRED = 'DEVICE_INTEGRITY_REQUIRED';
const DEVICE_INTEGRITY_MIN_CONFIDENCE = Math.max(
	1,
	Math.min(100, Number(process.env.DEVICE_INTEGRITY_MIN_CONFIDENCE || 78)),
);
const SIGNATURE_MAX_AGE_MS = Math.max(
	60_000,
	Number(process.env.DEVICE_INTEGRITY_SIGNATURE_MAX_AGE_MS || 5 * 60_000),
);

const BLOCK_MESSAGE =
	'Un vote a déjà été enregistré depuis cet appareil pour ce sondage. Pour préserver l’intégrité des résultats, un seul vote par appareil est autorisé.';

const REQUIRED_MESSAGE =
	"Nous n'avons pas pu vérifier l'intégrité de cet appareil. Pour protéger les résultats du sondage, le vote ne peut pas être enregistré depuis cette session.";

const MACHINE_LOCK_KINDS = new Set([
	DEVICE_LOCK_KINDS.MACHINE_STRONG,
	DEVICE_LOCK_KINDS.MACHINE_NETWORK,
	DEVICE_LOCK_KINDS.MACHINE_STABLE_NETWORK,
	DEVICE_LOCK_KINDS.MACHINE_STABLE_VARIANT_NETWORK,
	DEVICE_LOCK_KINDS.MACHINE_STABLE_VARIANT_HARDWARE,
]);

const asString = (value, max = 500) => String(value || '').trim().slice(0, max);

const getSecret = () =>
	asString(
		process.env.DEVICE_INTEGRITY_HASH_SECRET ||
			process.env.FRAUD_DEVICE_HASH_SECRET ||
			process.env.FRAUD_DEVICE_COOKIE_SECRET ||
			'',
		);

const hmac = (value) => {
	const secret = getSecret();
	if (!secret || !value) return null;
	return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
};

const base64urlToBuffer = (value) => {
	const normalized = asString(value, 20_000).replace(/-/g, '+').replace(/_/g, '/');
	const padding = normalized.length % 4 ? '='.repeat(4 - (normalized.length % 4)) : '';
	return Buffer.from(normalized + padding, 'base64');
};

const stableStringify = (value) => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const sanitizePrimitive = (value, max = 160) => {
	if (typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) {
		return value
			.map((entry) => sanitizePrimitive(entry, max))
			.filter((entry) => entry !== '' && entry !== null && typeof entry !== 'undefined')
			.slice(0, 12);
	}
	return asString(value, max);
};

const normalizeSignals = (signals = {}) => {
	if (!signals || typeof signals !== 'object') return {};
	const screen = signals.screen || {};
	const uaData = signals.uaData || {};
	const webgl = signals.webgl || {};
	return {
		screen: {
			width: Number(screen.width || 0) || 0,
			height: Number(screen.height || 0) || 0,
			colorDepth: Number(screen.colorDepth || 0) || 0,
			pixelRatio: Number(screen.pixelRatio || 0) || 0,
		},
		timezone: sanitizePrimitive(signals.timezone),
		timezoneOffset: Number(signals.timezoneOffset || 0) || 0,
		languages: sanitizePrimitive(signals.languages || []),
		platform: sanitizePrimitive(signals.platform),
		maxTouchPoints: Number(signals.maxTouchPoints || 0) || 0,
		hardwareConcurrency: Number(signals.hardwareConcurrency || 0) || 0,
		deviceMemory: Number(signals.deviceMemory || 0) || 0,
		uaData: {
			platform: sanitizePrimitive(uaData.platform),
			mobile: Boolean(uaData.mobile),
		},
		webgl: {
			vendor: sanitizePrimitive(webgl.vendor),
			renderer: sanitizePrimitive(webgl.renderer),
		},
	};
};

const scoreHardwareEntropy = (signals = {}) => {
	const checks = [
		signals.screen?.width && signals.screen?.height,
		signals.screen?.colorDepth,
		signals.timezone,
		Array.isArray(signals.languages) && signals.languages.length,
		signals.platform,
		typeof signals.maxTouchPoints === 'number',
		signals.hardwareConcurrency,
		signals.deviceMemory,
		signals.uaData?.platform,
		signals.webgl?.vendor,
		signals.webgl?.renderer,
	];
	return checks.filter(Boolean).length;
};

const hashPublicKey = (publicKey) => {
	if (!publicKey || typeof publicKey !== 'object') return null;
	const keyMaterial = {
		kty: asString(publicKey.kty, 20),
		crv: asString(publicKey.crv, 20),
		x: asString(publicKey.x, 500),
		y: asString(publicKey.y, 500),
	};
	if (keyMaterial.kty !== 'EC' || keyMaterial.crv !== 'P-256' || !keyMaterial.x || !keyMaterial.y) {
		return null;
	}
	return hmac(`webcrypto:${stableStringify(keyMaterial)}`);
};

const verifySignedDevicePayload = async ({ payload, surveyId, surveyType }) => {
	try {
		if (!payload || typeof payload !== 'object') return false;
		const publicKey = payload.publicKey;
		const signedPayloadRaw = asString(payload.signedPayload, 60_000);
		const signatureRaw = asString(payload.signature, 20_000);
		if (!publicKey || !signedPayloadRaw || !signatureRaw) return false;

		const signedPayload = JSON.parse(signedPayloadRaw);
		const createdAtMs = Date.parse(signedPayload.createdAt || '');
		if (!Number.isFinite(createdAtMs)) return false;
		if (Math.abs(Date.now() - createdAtMs) > SIGNATURE_MAX_AGE_MS) return false;
		if (asString(signedPayload.challengeId, 120) !== asString(payload.challengeId, 120)) {
			return false;
		}
		if (asString(signedPayload.signalsVersion, 80) !== DEVICE_INTEGRITY_VERSION) {
			return false;
		}
		if (asString(signedPayload.context?.surveyId, 80) !== String(surveyId)) return false;
		if (asString(signedPayload.context?.surveyType, 40) !== String(surveyType)) return false;
		if (stableStringify(signedPayload.publicKey) !== stableStringify(publicKey)) return false;

		const cryptoKey = await crypto.webcrypto.subtle.importKey(
			'jwk',
			publicKey,
			{ name: 'ECDSA', namedCurve: 'P-256' },
			false,
			['verify'],
		);
		return crypto.webcrypto.subtle.verify(
			{ name: 'ECDSA', hash: 'SHA-256' },
			cryptoKey,
			base64urlToBuffer(signatureRaw),
			Buffer.from(signedPayloadRaw, 'utf8'),
		);
	} catch (_error) {
		return false;
	}
};

const buildCandidate = ({ kind, raw, confidence, meta = null }) => {
	const lockKeyHash = hmac(`${kind}:${raw}`);
	if (!lockKeyHash) return null;
	return {
		lockKind: kind,
		lockKeyHash,
		confidence: Number(confidence || 0),
		meta,
	};
};

const finalizeCandidates = (candidates = []) => {
	const uniqueByKey = new Map();
	candidates
		.filter(Boolean)
		.filter((entry) => Number(entry.confidence || 0) >= DEVICE_INTEGRITY_MIN_CONFIDENCE)
		.forEach((entry) => {
			if (!uniqueByKey.has(entry.lockKeyHash)) uniqueByKey.set(entry.lockKeyHash, entry);
		});

	return [...uniqueByKey.values()].sort((a, b) => b.confidence - a.confidence);
};

const buildDeviceLockCandidates = async ({
	req,
	surveyId,
	surveyType,
	extraCandidates = [],
}) => {
	const payload = req.body?.deviceIntegrity || {};
	const candidates = [...extraCandidates];

	if (req.riskIdentity?.deviceHash && !req.riskIdentity?.deviceCookieCreated) {
		candidates.push(
			buildCandidate({
				kind: DEVICE_LOCK_KINDS.COOKIE,
				raw: req.riskIdentity.deviceHash,
				confidence: 100,
				meta: { cookieSigned: Boolean(req.riskIdentity.deviceCookieSigned) },
			}),
		);
	}

	const signatureValid = await verifySignedDevicePayload({
		payload,
		surveyId,
		surveyType,
	});
	const publicKeyHash = signatureValid ? hashPublicKey(payload.publicKey) : null;
	if (publicKeyHash) {
		candidates.push(
			buildCandidate({
				kind: DEVICE_LOCK_KINDS.WEBCRYPTO,
				raw: publicKeyHash,
				confidence: 95,
				meta: { signatureValid: true },
			}),
		);
	}

	const fingerprint = payload?.fingerprint || {};
	const visitorId = asString(fingerprint.visitorId, 500);
	if (visitorId && /^[a-zA-Z0-9_-]{12,}$/.test(visitorId)) {
		candidates.push(
			buildCandidate({
				kind: DEVICE_LOCK_KINDS.FINGERPRINT,
				raw: visitorId,
				confidence: 88,
				meta: { provider: 'fingerprintjs-oss' },
			}),
		);
	}

	const normalizedSignals = normalizeSignals(fingerprint.signals || {});
	const entropyScore = scoreHardwareEntropy(normalizedSignals);
	if (entropyScore >= 7) {
		candidates.push(
			buildCandidate({
				kind: DEVICE_LOCK_KINDS.HARDWARE,
				raw: stableStringify(normalizedSignals),
				confidence: Math.min(86, 70 + entropyScore),
				meta: { entropyScore },
			}),
		);
	}

	return finalizeCandidates(candidates);
};

const buildBlockResponse = (code, message, extra = {}) => ({
	ok: false,
	httpStatus: 403,
	code,
	message,
	...extra,
});

const logDeviceDecision = ({
	decision,
	userId,
	surveyId,
	surveyType,
	identity,
	reasons = [],
	meta = null,
}) =>
	logFraudDecision({
		event: 'vote_decision',
		actionType: 'vote',
		decision,
		userId,
		surveyId,
		surveyType,
		opinionModel: 'DeviceVoteLock',
		ipHash: identity?.ipHash || null,
		deviceHash: identity?.deviceHash || null,
		riskScore: decision === 'blocked' ? 100 : 0,
		reasons,
		challengeType: 'none',
		meta,
	});

const reserveDeviceVote = async ({ req, userId, surveyId, surveyType, fraudDecision = null }) => {
	const machineDecision = await evaluateMachineSignatureVote({
		req,
		userId,
		surveyId,
		surveyType,
		fraudDecision,
	});

	if (!machineDecision.ok) {
		await logDeviceDecision({
			decision: 'blocked',
			userId,
			surveyId,
			surveyType,
			identity: req.riskIdentity || {},
			reasons: [
				machineDecision.code,
				...(machineDecision.matchedFamilies || []).map((entry) => `MACHINE_${String(entry).toUpperCase()}`),
			],
			meta: {
				similarityScore: machineDecision.similarityScore || 0,
				matchedTraceId: machineDecision.matchedTraceId || null,
				vpnRisk: machineDecision.machineSignature?.vpnRisk || null,
			},
		});
		return buildBlockResponse(machineDecision.code, machineDecision.message, {
			confidence: machineDecision.similarityScore || 100,
			matchedFamilies: machineDecision.matchedFamilies || [],
		});
	}

	const machineLockCandidates = buildMachineLockCandidates(machineDecision.machineSignature)
		.map((candidate) =>
			buildCandidate({
				kind: candidate.kind,
				raw: candidate.raw,
				confidence: candidate.confidence,
				meta: candidate.meta,
			}),
		)
		.filter(Boolean);

	const candidates = await buildDeviceLockCandidates({
		req,
		surveyId,
		surveyType,
		extraCandidates: machineLockCandidates,
	});
	if (!candidates.length) {
		await logDeviceDecision({
			decision: 'blocked',
			userId,
			surveyId,
			surveyType,
			identity: req.riskIdentity || {},
			reasons: [DEVICE_INTEGRITY_REQUIRED],
			meta: { reason: 'no-reliable-device-candidate' },
		});
		return buildBlockResponse(DEVICE_INTEGRITY_REQUIRED, REQUIRED_MESSAGE);
	}

	const lockIds = [];
	const createdLockIds = [];

	for (const candidate of candidates) {
		try {
			const created = await DeviceVoteLock.create({
				surveyId,
				surveyType,
				lockKeyHash: candidate.lockKeyHash,
				lockKind: candidate.lockKind,
				firstUserId: userId,
				confidence: candidate.confidence,
				status: DEVICE_LOCK_STATUSES.PENDING,
				signalsVersion: DEVICE_INTEGRITY_VERSION,
				meta: candidate.meta,
			});
			lockIds.push(created._id);
			createdLockIds.push(created._id);
		} catch (error) {
			if (error?.code !== 11000) throw error;
			const existing = await DeviceVoteLock.findOne({
				surveyId,
				surveyType,
				lockKeyHash: candidate.lockKeyHash,
			})
				.select('_id firstUserId lockKind confidence status')
				.lean();

			if (!existing) throw error;
			if (String(existing.firstUserId) === String(userId)) {
				lockIds.push(existing._id);
				continue;
			}

			await releaseDeviceVoteLocks({ lockIds: createdLockIds, userId });
			const machineLock = MACHINE_LOCK_KINDS.has(candidate.lockKind);
			const duplicateCode =
				machineLock ? DEVICE_MACHINE_ALREADY_USED : DEVICE_VOTE_ALREADY_USED;
			const duplicateMessage = machineLock ? MACHINE_BLOCK_MESSAGE : BLOCK_MESSAGE;

			await logDeviceDecision({
				decision: 'blocked',
				userId,
				surveyId,
				surveyType,
				identity: req.riskIdentity || {},
				reasons: [duplicateCode, `DEVICE_LOCK_${String(candidate.lockKind || '').toUpperCase()}`],
				meta: {
					lockKind: candidate.lockKind,
					confidence: candidate.confidence,
					existingStatus: existing.status,
					machineDecision:
						machineLock ?
							{
								similarityScore: machineDecision.similarityScore || candidate.confidence,
								matchedFamilies: machineDecision.matchedFamilies || [],
							}
						:	null,
				},
			});
			return buildBlockResponse(duplicateCode, duplicateMessage, {
				lockKind: candidate.lockKind,
				confidence: candidate.confidence,
			});
		}
	}

	return {
		ok: true,
		lockIds,
		createdLockIds,
		userId,
		surveyId,
		surveyType,
		machineDecision,
		machineSignature: machineDecision.machineSignature || null,
		candidates: candidates.map((entry) => ({
			lockKind: entry.lockKind,
			confidence: entry.confidence,
		})),
	};
};

const commitDeviceVoteLocks = async ({ reservation, opinionId }) => {
	if (!reservation?.ok || !reservation.lockIds?.length) return;
	await DeviceVoteLock.updateMany(
		{ _id: { $in: reservation.lockIds } },
		{
			$set: {
				firstOpinionId: opinionId,
				status: DEVICE_LOCK_STATUSES.COMMITTED,
			},
		},
	);
};

const releaseDeviceVoteLocks = async ({ lockIds = [], userId }) => {
	const ids = (lockIds || []).filter((id) => mongoose.Types.ObjectId.isValid(String(id)));
	if (!ids.length) return;
	await DeviceVoteLock.deleteMany({
		_id: { $in: ids },
		firstUserId: userId,
		status: DEVICE_LOCK_STATUSES.PENDING,
	});
};

module.exports = {
	DEVICE_INTEGRITY_REQUIRED,
	DEVICE_MACHINE_ALREADY_USED,
	DEVICE_VPN_BLOCKED,
	DEVICE_VOTE_ALREADY_USED,
	BLOCK_MESSAGE,
	REQUIRED_MESSAGE,
	DEVICE_INTEGRITY_VERSION,
	applyMachineDecisionToFraudDecision,
	buildDeviceLockCandidates,
	commitDeviceTrace,
	reserveDeviceVote,
	commitDeviceVoteLocks,
	releaseDeviceVoteLocks,
};
