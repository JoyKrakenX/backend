/** @format */

const crypto = require('crypto');

const DeviceAccountLink = require('../../models/DeviceAccountLink');
const { DEVICE_ACCOUNT_LINK_KINDS } = require('../../models/DeviceAccountLink');
const DeviceTrace = require('../../models/DeviceTrace');
const { MACHINE_TRACE_DECISIONS } = require('../../models/DeviceTrace');
const { FRAUD_STATUSES } = require('../../utils/fraudConfig');

const MACHINE_SIGNATURE_VERSION = 'machine-signature-v2';
const DEVICE_MACHINE_ALREADY_USED = 'DEVICE_MACHINE_ALREADY_USED';
const DEVICE_VPN_BLOCKED = 'DEVICE_VPN_BLOCKED';
const DEVICE_MACHINE_REVIEW = 'DEVICE_MACHINE_REVIEW';

const MACHINE_BLOCK_MESSAGE =
	'Un vote semble déjà avoir été enregistré depuis cet appareil ou un environnement technique très proche pour ce sondage. Pour préserver l’intégrité des résultats, un seul vote par appareil est autorisé.';
const VPN_BLOCK_MESSAGE =
	'Cette connexion semble utiliser un VPN, un proxy, Tor ou un réseau technique à risque. Pour préserver l’intégrité des résultats, le vote ne peut pas être enregistré depuis cette connexion.';

const BLOCK_MIN = Math.max(
	80,
	Math.min(100, Number(process.env.MACHINE_SIGNATURE_BLOCK_MIN || 92)),
);
const REVIEW_MIN = Math.max(
	60,
	Math.min(BLOCK_MIN - 1, Number(process.env.MACHINE_SIGNATURE_REVIEW_MIN || 82)),
);

const SELECTED_COMPONENTS = [
	'audio',
	'canvas',
	'colorDepth',
	'deviceMemory',
	'fontPreferences',
	'fonts',
	'hardwareConcurrency',
	'languages',
	'math',
	'platform',
	'plugins',
	'screenFrame',
	'screenResolution',
	'timezone',
	'touchSupport',
	'vendor',
	'vendorFlavors',
	'webGlBasics',
	'webGlExtensions',
];

const COMPONENT_WEIGHTS = Object.freeze({
	canvas: 8,
	audio: 8,
	math: 6,
	webGlBasics: 8,
	webGlExtensions: 6,
	fontPreferences: 5,
	fonts: 5,
	screenResolution: 4,
	screenFrame: 4,
	hardwareConcurrency: 3,
	deviceMemory: 3,
	timezone: 3,
	platform: 3,
	touchSupport: 3,
});

const STRICT_PROFILE_COMPONENTS = Object.freeze([
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
]);

const STRICT_REQUIRED_COMPONENTS = Object.freeze([
	'screenResolution',
	'screenFrame',
	'timezone',
	'platform',
	'touchSupport',
]);

const STABLE_LOCK_VARIANTS = Object.freeze([
	{
		name: 'core_fonts_math',
		components: [
			'screenResolution',
			'screenFrame',
			'timezone',
			'platform',
			'touchSupport',
			'fonts',
			'math',
		],
	},
	{
		name: 'core_vendor_language',
		components: [
			'screenResolution',
			'screenFrame',
			'timezone',
			'platform',
			'touchSupport',
			'languages',
			'vendor',
			'plugins',
		],
	},
	{
		name: 'core_device_capacity',
		components: [
			'screenResolution',
			'screenFrame',
			'timezone',
			'platform',
			'touchSupport',
			'hardwareConcurrency',
			'deviceMemory',
			'fonts',
		],
	},
	{
		name: 'core_rendering_soft',
		components: [
			'screenResolution',
			'screenFrame',
			'timezone',
			'platform',
			'touchSupport',
			'canvas',
			'audio',
			'fonts',
		],
	},
]);

const STRICT_NETWORK_COMPONENT_MIN = Math.max(
	6,
	Math.min(STRICT_PROFILE_COMPONENTS.length, Number(process.env.MACHINE_STABLE_NETWORK_MIN || 8)),
);

const STRICT_HARDWARE_COMPONENT_MIN = Math.max(
	8,
	Math.min(STRICT_PROFILE_COMPONENTS.length, Number(process.env.MACHINE_STABLE_HARDWARE_MIN || 10)),
);

const asString = (value, max = 500) => String(value || '').trim().slice(0, max);
const normalizeText = (value, max = 180) =>
	asString(value, max)
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

const getSecret = () =>
	asString(
		process.env.MACHINE_SIGNATURE_HASH_SECRET ||
			process.env.DEVICE_INTEGRITY_HASH_SECRET ||
			process.env.FRAUD_DEVICE_HASH_SECRET ||
			'',
	);

const hmac = (value) => {
	const secret = getSecret();
	if (!secret || !value) return null;
	return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
};

const stableStringify = (value) => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
};

const roundBucket = (value, size) => {
	const parsed = Number(value || 0);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.round(parsed / size) * size;
};

const cpuBucket = (value) => {
	const parsed = Number(value || 0);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	if (parsed <= 2) return 2;
	if (parsed <= 4) return 4;
	if (parsed <= 8) return 8;
	if (parsed <= 12) return 12;
	if (parsed <= 16) return 16;
	return 32;
};

const memoryBucket = (value) => {
	const parsed = Number(value || 0);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	if (parsed <= 1) return 1;
	if (parsed <= 2) return 2;
	if (parsed <= 4) return 4;
	if (parsed <= 8) return 8;
	return 16;
};

const compactValue = (value, max = 900, depth = 0) => {
	if (depth > 4) return '[depth-limit]';
	if (value === null || typeof value === 'undefined') return null;
	if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return asString(value, max);
	if (Array.isArray(value)) {
		return value.slice(0, 30).map((entry) => compactValue(entry, Math.floor(max / 2), depth + 1));
	}
	if (typeof value === 'object') {
		const output = {};
		for (const key of Object.keys(value).sort().slice(0, 40)) {
			output[asString(key, 80)] = compactValue(value[key], Math.floor(max / 2), depth + 1);
		}
		return output;
	}
	return asString(value, max);
};

const hashFamily = (name, value) => {
	const normalized = compactValue(value);
	const serialized = stableStringify(normalized);
	if (!serialized || serialized === '{}' || serialized === 'null') return null;
	return hmac(`${MACHINE_SIGNATURE_VERSION}:${name}:${serialized}`);
};

const normalizeScreen = (signals = {}) => {
	const screen = signals.screen || {};
	const width = Number(screen.width || 0) || 0;
	const height = Number(screen.height || 0) || 0;
	const availWidth = Number(screen.availWidth || 0) || 0;
	const availHeight = Number(screen.availHeight || 0) || 0;
	const sorted = [width, height].filter(Boolean).sort((a, b) => b - a);
	const sortedAvail = [availWidth, availHeight].filter(Boolean).sort((a, b) => b - a);
	return {
		resolution: sorted.length === 2 ? `${roundBucket(sorted[0], 40)}x${roundBucket(sorted[1], 40)}` : '',
		available:
			sortedAvail.length === 2 ?
				`${roundBucket(sortedAvail[0], 40)}x${roundBucket(sortedAvail[1], 40)}`
			:	'',
		colorDepth: Number(screen.colorDepth || 0) || 0,
		pixelRatio: roundBucket(Number(screen.pixelRatio || 0) * 100, 25) / 100,
	};
};

const extractComponentHashes = (components = {}) => {
	if (!components || typeof components !== 'object') return {};
	const hashes = {};
	for (const name of SELECTED_COMPONENTS) {
		const entry = components[name];
		const value =
			entry && typeof entry === 'object' && Object.prototype.hasOwnProperty.call(entry, 'value') ?
				entry.value
			:	entry;
		const hashed = hashFamily(`component:${name}`, value);
		if (hashed) hashes[name] = hashed;
	}
	return hashes;
};

const classifyVpnRisk = (ipReputation = {}) => {
	const raw = ipReputation?.raw || {};
	const connectionType = normalizeText(raw.connection_type, 120);
	const score = Number(ipReputation?.score || raw.fraud_score || 0) || 0;
	const tor = Boolean(raw.tor);
	const vpn = Boolean(raw.vpn || raw.active_vpn);
	const proxy = Boolean(raw.proxy);
	const datacenter =
		connectionType.includes('data center') ||
		connectionType.includes('hosting') ||
		connectionType.includes('transit');
	const abuse = Boolean(raw.recent_abuse || raw.bot_status || raw.is_crawler);
	const blocked = tor || datacenter || ((vpn || proxy) && score >= 70);
	const review = blocked || vpn || proxy || abuse || score >= 65;
	const reasons = [];
	if (tor) reasons.push('TOR_DETECTED');
	if (datacenter) reasons.push('DATACENTER_NETWORK');
	if (vpn) reasons.push('VPN_DETECTED');
	if (proxy) reasons.push('PROXY_DETECTED');
	if (abuse) reasons.push('IP_ABUSE_SIGNAL');
	if (score >= 65) reasons.push('IP_RISK_SCORE_HIGH');

	return {
		provider: ipReputation?.provider || 'none',
		score: Math.max(0, Math.min(100, score)),
		blocked,
		review,
		reasons,
		connectionType: connectionType || null,
	};
};

const buildMachineSignature = ({ req, fraudDecision }) => {
	const payload = req?.body?.deviceIntegrity || {};
	const fingerprint = payload?.fingerprint || {};
	const signals = fingerprint?.signals || {};
	const ua = req?.riskIdentity?.ua || {};
	const screen = normalizeScreen(signals);
	const components = extractComponentHashes(fingerprint?.components || {});
	const ipReputation = fraudDecision?.providerMeta?.ipReputation || {};
	const vpnRisk = classifyVpnRisk(ipReputation);
	const uaData = signals.uaData || {};
	const webgl = signals.webgl || {};

	const primaryLanguage =
		Array.isArray(signals.languages) && signals.languages.length ?
			normalizeText(signals.languages[0], 40)
		:	'';

	const hardwareCore = {
		os: normalizeText(ua.os || uaData.platform || signals.platform, 80),
		platform: normalizeText(signals.platform || uaData.platform, 80),
		screen,
		cpu: cpuBucket(signals.hardwareConcurrency),
		memory: memoryBucket(signals.deviceMemory),
		touch: Math.min(10, Number(signals.maxTouchPoints || 0) || 0),
		mobile: Boolean(uaData.mobile),
		architecture: normalizeText(uaData.architecture, 40),
		bitness: normalizeText(uaData.bitness, 20),
	};

	const rendering = {
		webglVendor: normalizeText(webgl.vendor, 160),
		webglRenderer: normalizeText(webgl.renderer, 220),
		canvas: components.canvas || null,
		audio: components.audio || null,
		math: components.math || null,
		webGlBasics: components.webGlBasics || null,
		webGlExtensions: components.webGlExtensions || null,
	};

	const environment = {
		timezone: normalizeText(signals.timezone, 80),
		timezoneOffset: Number(signals.timezoneOffset || 0) || 0,
		language: primaryLanguage,
		browserFamily: normalizeText(ua.browser, 80),
		deviceType: normalizeText(ua.device, 40),
		colorDepth: screen.colorDepth,
	};

	const networkContext = {
		ipHash: asString(req?.riskIdentity?.ipHash, 140),
		connectionType: vpnRisk.connectionType,
		timezone: environment.timezone,
		language: environment.language,
	};

	const browserProof = {
		deviceHash: asString(req?.riskIdentity?.deviceHash, 140),
		visitorId: asString(fingerprint?.visitorId, 500),
		publicKeyX: asString(payload?.publicKey?.x, 500),
	};

	const hardwareSignalCount = [
		hardwareCore.os,
		hardwareCore.platform,
		screen.resolution,
		screen.colorDepth,
		hardwareCore.cpu,
		hardwareCore.memory,
		typeof hardwareCore.touch === 'number',
	].filter(Boolean).length;
	const renderingSignalCount = [
		rendering.webglVendor,
		rendering.webglRenderer,
		rendering.canvas,
		rendering.audio,
		rendering.math,
		rendering.webGlBasics,
		rendering.webGlExtensions,
	].filter(Boolean).length;
	const environmentSignalCount = [
		environment.timezone,
		environment.language,
		environment.deviceType,
		environment.colorDepth,
	].filter(Boolean).length;

	const hardwareCoreHash =
		hardwareSignalCount >= 4 ? hashFamily('hardware_core', hardwareCore) : null;
	const renderingHash =
		renderingSignalCount >= 2 ? hashFamily('rendering', rendering) : null;
	const environmentHash =
		environmentSignalCount >= 2 ? hashFamily('environment', environment) : null;
	const networkContextHash =
		networkContext.ipHash ? hashFamily('network_context', networkContext) : null;
	const browserProofHash =
		browserProof.deviceHash || browserProof.visitorId || browserProof.publicKeyX ?
			hashFamily('browser_proof', browserProof)
		:	null;

	return {
		version: MACHINE_SIGNATURE_VERSION,
		hardwareCoreHash,
		renderingHash,
		environmentHash,
		networkContextHash,
		browserProofHash,
		componentHashes: components,
		vpnRisk,
		presentFamilies: [
			hardwareCoreHash ? 'hardware' : null,
			renderingHash ? 'rendering' : null,
			environmentHash ? 'environment' : null,
			networkContextHash ? 'network' : null,
			browserProofHash ? 'browser' : null,
		].filter(Boolean),
	};
};

const buildMachineLockCandidates = (signature) => {
	if (!signature) return [];
	const candidates = [];
	if (signature.hardwareCoreHash && signature.renderingHash && signature.environmentHash) {
		candidates.push({
			kind: 'machine_strong',
			raw: stableStringify({
				hardwareCoreHash: signature.hardwareCoreHash,
				renderingHash: signature.renderingHash,
				environmentHash: signature.environmentHash,
			}),
			confidence: 94,
			meta: { version: MACHINE_SIGNATURE_VERSION, families: ['hardware', 'rendering', 'environment'] },
		});
	}
	if (signature.hardwareCoreHash && signature.renderingHash && signature.networkContextHash) {
		candidates.push({
			kind: 'machine_network',
			raw: stableStringify({
				hardwareCoreHash: signature.hardwareCoreHash,
				renderingHash: signature.renderingHash,
				networkContextHash: signature.networkContextHash,
			}),
			confidence: 93,
			meta: { version: MACHINE_SIGNATURE_VERSION, families: ['hardware', 'rendering', 'network'] },
		});
	}
	const stableProfile = buildStableComponentProfile(signature.componentHashes || {});
	if (signature.networkContextHash && stableProfile?.hash) {
		candidates.push({
			kind: 'machine_stable_network',
			raw: stableStringify({
				networkContextHash: signature.networkContextHash,
				stableProfileHash: stableProfile.hash,
			}),
			confidence: 96,
			meta: {
				version: MACHINE_SIGNATURE_VERSION,
				families: ['network', 'stable_components'],
				components: stableProfile.names,
				componentCount: stableProfile.count,
			},
		});
	}
	const stableVariants = buildStableVariantProfiles(signature.componentHashes || {});
	for (const variant of stableVariants) {
		if (signature.networkContextHash) {
			candidates.push({
				kind: 'machine_stable_variant_network',
				raw: stableStringify({
					networkContextHash: signature.networkContextHash,
					variantName: variant.name,
					variantHash: variant.hash,
				}),
				confidence: 97,
				meta: {
					version: MACHINE_SIGNATURE_VERSION,
					families: ['network', 'stable_component_variant'],
					variant: variant.name,
					components: variant.components,
					componentCount: variant.count,
				},
			});
		}
		if (signature.hardwareCoreHash) {
			candidates.push({
				kind: 'machine_stable_variant_hardware',
				raw: stableStringify({
					hardwareCoreHash: signature.hardwareCoreHash,
					variantName: variant.name,
					variantHash: variant.hash,
				}),
				confidence: 94,
				meta: {
					version: MACHINE_SIGNATURE_VERSION,
					families: ['hardware', 'stable_component_variant'],
					variant: variant.name,
					components: variant.components,
					componentCount: variant.count,
				},
			});
		}
	}
	return candidates;
};

const toPlainComponentHashes = (componentHashes) => {
	if (!componentHashes) return {};
	if (componentHashes instanceof Map) return Object.fromEntries(componentHashes.entries());
	return { ...componentHashes };
};

const buildStableComponentProfile = (components = {}) => {
	const selected = {};
	for (const name of STRICT_PROFILE_COMPONENTS) {
		if (components[name]) selected[name] = components[name];
	}
	const names = Object.keys(selected).sort();
	if (names.length < STRICT_NETWORK_COMPONENT_MIN) return null;
	return {
		hash: hashFamily('stable_component_profile', selected),
		names,
		count: names.length,
	};
};

const buildStableVariantProfiles = (components = {}) => {
	const profiles = [];
	for (const variant of STABLE_LOCK_VARIANTS) {
		const selected = {};
		let complete = true;
		for (const name of variant.components) {
			if (!components[name]) {
				complete = false;
				break;
			}
			selected[name] = components[name];
		}
		if (!complete) continue;
		const hash = hashFamily(`stable_component_variant:${variant.name}`, selected);
		if (!hash) continue;
		profiles.push({
			name: variant.name,
			hash,
			components: [...variant.components],
			count: variant.components.length,
		});
	}
	return profiles;
};

const getMatchedComponents = (currentComponents = {}, existingComponents = {}) =>
	Object.keys(currentComponents)
		.filter((name) => currentComponents[name] && currentComponents[name] === existingComponents[name])
		.sort();

const getStableMatchDetails = (matchedComponents = []) => {
	const matchedSet = new Set(matchedComponents);
	const stableMatches = STRICT_PROFILE_COMPONENTS.filter((name) => matchedSet.has(name));
	const requiredMatches = STRICT_REQUIRED_COMPONENTS.filter((name) => matchedSet.has(name));
	const hasRequiredCore = STRICT_REQUIRED_COMPONENTS.every((name) => matchedSet.has(name));
	return {
		stableMatches,
		requiredMatches,
		hasRequiredCore,
		count: stableMatches.length,
	};
};

const normalizeId = (value) => {
	const normalized = asString(value, 80);
	return normalized || null;
};

const sortUserPair = (left, right) => {
	const a = normalizeId(left);
	const b = normalizeId(right);
	if (!a || !b || a === b) return null;
	return [a, b].sort();
};

const getCompatibleSurveyTypes = (surveyType) => {
	switch (String(surveyType || '')) {
		case 'binary':
		case 'binary_flash':
			return ['binary', 'binary_flash'];
		case 'multiple':
		case 'multiple_flash':
			return ['multiple', 'multiple_flash'];
		default:
			return [String(surveyType || 'unknown')];
	}
};

const upsertDeviceAccountLink = async ({
	userId,
	matchedTrace,
	comparison,
	linkKind = DEVICE_ACCOUNT_LINK_KINDS.MACHINE_SIGNATURE,
}) => {
	try {
		const pair = sortUserPair(userId, matchedTrace?.userId);
		if (!pair) return null;
		const now = new Date();
		const retentionDays = Math.max(
			30,
			Math.min(400, Number(process.env.DEVICE_ACCOUNT_LINK_RETENTION_DAYS || 400) || 400),
		);
		const expiresAt = new Date(
			now.getTime() + retentionDays * 24 * 60 * 60 * 1000,
		);
		const [userA, userB] = pair;
		const matchedFamilies = comparison?.matchedFamilies || [];
		const update = {
			$setOnInsert: {
				userA,
				userB,
				firstSurveyId: matchedTrace?.surveyId || null,
				firstSurveyType: matchedTrace?.surveyType || null,
				firstTraceId: matchedTrace?._id || null,
				linkKind,
				createdAt: now,
			},
			$set: {
				lastSeenAt: now,
				matchedTraceId: matchedTrace?._id || null,
				expiresAt,
				evidence: {
					source: 'machine-signature-v2.2',
					score: Math.max(0, Math.min(100, Number(comparison?.score || 0))),
					matchedFamilies,
				},
				updatedAt: now,
			},
			$max: {
				confidence: Math.max(0, Math.min(100, Number(comparison?.score || 0))),
			},
			$addToSet: {
				matchedFamilies: { $each: matchedFamilies },
			},
		};
		return DeviceAccountLink.updateOne({ userA, userB }, update, { upsert: true });
	} catch (error) {
		console.error('DeviceAccountLink upsert failed:', error?.message || error);
		return null;
	}
};

const findLinkedAccountVoteMatch = async ({ userId, surveyId, surveyType }) => {
	const normalizedUserId = normalizeId(userId);
	if (!normalizedUserId) return null;
	const links = await DeviceAccountLink.find({
		$or: [{ userA: normalizedUserId }, { userB: normalizedUserId }],
		confidence: { $gte: 92 },
	})
		.select('userA userB confidence matchedFamilies linkKind lastSeenAt')
		.sort({ confidence: -1, lastSeenAt: -1 })
		.limit(50)
		.lean();
	const linkedUserIds = [
		...new Set(
			links
				.map((link) =>
					String(link.userA) === normalizedUserId ? String(link.userB) : String(link.userA),
				)
				.filter(Boolean),
		),
	];
	if (!linkedUserIds.length) return null;
	const trace = await DeviceTrace.findOne({
		surveyId,
		surveyType: { $in: getCompatibleSurveyTypes(surveyType) },
		userId: { $in: linkedUserIds },
	})
		.select('userId opinionId surveyId surveyType decision matchedFamilies similarityScore createdAt')
		.sort({ createdAt: -1 })
		.lean();
	if (!trace) return null;
	const link = links.find((entry) =>
		[String(entry.userA), String(entry.userB)].some((entryUserId) => entryUserId === String(trace.userId)),
	);
	return {
		trace,
		link,
		score: Math.max(96, Number(link?.confidence || 0)),
		matchedFamilies: [
			'account_link',
			...(Array.isArray(link?.matchedFamilies) ? link.matchedFamilies : []),
		],
	};
};

const compareTrace = (signature, trace) => {
	const matchedFamilies = [];
	let score = 0;
	let componentScore = 0;

	const add = (condition, family, weight) => {
		if (!condition) return;
		matchedFamilies.push(family);
		score += weight;
	};

	add(signature.browserProofHash && signature.browserProofHash === trace.browserProofHash, 'browser', 100);
	add(signature.hardwareCoreHash && signature.hardwareCoreHash === trace.hardwareCoreHash, 'hardware', 30);
	add(signature.renderingHash && signature.renderingHash === trace.renderingHash, 'rendering', 30);
	add(signature.environmentHash && signature.environmentHash === trace.environmentHash, 'environment', 14);
	add(signature.networkContextHash && signature.networkContextHash === trace.networkContextHash, 'network', 10);

	const currentComponents = signature.componentHashes || {};
	const existingComponents = toPlainComponentHashes(trace.componentHashes);
	const matchedComponents = getMatchedComponents(currentComponents, existingComponents);
	for (const [name, weight] of Object.entries(COMPONENT_WEIGHTS)) {
		if (matchedComponents.includes(name)) {
			componentScore += weight;
			matchedFamilies.push(`component:${name}`);
		}
	}
	score += Math.min(24, componentScore);

	const uniqueFamilies = new Set(
		matchedFamilies
			.map((entry) => String(entry).split(':')[0])
			.filter((entry) => entry !== 'component'),
	);
	const stableDetails = getStableMatchDetails(matchedComponents);
	const hasCoreMatch = uniqueFamilies.has('hardware') && uniqueFamilies.has('rendering');
	const hasContextMatch = uniqueFamilies.has('environment') || uniqueFamilies.has('network');
	const hasStableNetworkMatch =
		uniqueFamilies.has('network') &&
		stableDetails.hasRequiredCore &&
		stableDetails.count >= STRICT_NETWORK_COMPONENT_MIN &&
		(uniqueFamilies.has('environment') ||
			uniqueFamilies.has('hardware') ||
			stableDetails.count >= STRICT_PROFILE_COMPONENTS.length - 1);
	const hasStableHardwareMatch =
		uniqueFamilies.has('hardware') &&
		stableDetails.hasRequiredCore &&
		stableDetails.count >= STRICT_HARDWARE_COMPONENT_MIN;
	if (hasStableNetworkMatch) {
		score = Math.max(score, 95);
		matchedFamilies.push('stable:network_profile');
	}
	if (hasStableHardwareMatch) {
		score = Math.max(score, 92);
		matchedFamilies.push('stable:hardware_profile');
	}
	const blocked =
		uniqueFamilies.has('browser') ||
		hasStableNetworkMatch ||
		hasStableHardwareMatch ||
		(score >= BLOCK_MIN && hasCoreMatch && hasContextMatch) ||
		(score >= BLOCK_MIN + 2 && hasCoreMatch && componentScore >= 16);
	const quarantined =
		!blocked &&
		((score >= REVIEW_MIN && uniqueFamilies.size >= 2) ||
			(uniqueFamilies.has('network') &&
				stableDetails.hasRequiredCore &&
				stableDetails.count >= Math.max(6, STRICT_NETWORK_COMPONENT_MIN - 2)));

	return {
		trace,
		score: Math.max(0, Math.min(100, Math.round(score))),
		matchedFamilies: [...new Set(matchedFamilies)],
		blocked,
		quarantined,
	};
};

const findBestMatch = async ({ signature, userId, surveyId, surveyType }) => {
	if (!signature) return null;
	const traces = await DeviceTrace.find({
		surveyId,
		surveyType,
		userId: { $ne: userId },
	})
		.select(
			'userId opinionId hardwareCoreHash renderingHash environmentHash networkContextHash browserProofHash componentHashes decision createdAt',
		)
		.sort({ createdAt: -1 })
		.limit(1000)
		.lean();

	let best = null;
	for (const trace of traces) {
		const comparison = compareTrace(signature, trace);
		if (!best || comparison.score > best.score) best = comparison;
		if (comparison.blocked) break;
	}
	return best;
};

const evaluateMachineSignatureVote = async ({ req, userId, surveyId, surveyType, fraudDecision }) => {
	const machineSignature = buildMachineSignature({ req, fraudDecision });
	if (machineSignature.vpnRisk?.blocked) {
		return {
			ok: false,
			decision: MACHINE_TRACE_DECISIONS.BLOCKED,
			code: DEVICE_VPN_BLOCKED,
			message: VPN_BLOCK_MESSAGE,
			similarityScore: Math.max(92, Number(machineSignature.vpnRisk.score || 0)),
			matchedFamilies: machineSignature.vpnRisk.reasons || [],
			machineSignature,
		};
	}

	const linkedAccountMatch = await findLinkedAccountVoteMatch({
		userId,
		surveyId,
		surveyType,
	});
	if (linkedAccountMatch?.trace) {
		return {
			ok: false,
			decision: MACHINE_TRACE_DECISIONS.BLOCKED,
			code: DEVICE_MACHINE_ALREADY_USED,
			message: MACHINE_BLOCK_MESSAGE,
			similarityScore: linkedAccountMatch.score,
			matchedFamilies: linkedAccountMatch.matchedFamilies,
			matchedTraceId: linkedAccountMatch.trace?._id || null,
			machineSignature,
		};
	}

	const bestMatch = await findBestMatch({
		signature: machineSignature,
		userId,
		surveyId,
		surveyType,
	});

	if (bestMatch?.blocked) {
		await upsertDeviceAccountLink({
			userId,
			matchedTrace: bestMatch.trace,
			comparison: bestMatch,
			linkKind:
				bestMatch.matchedFamilies?.some((family) => String(family).startsWith('stable:')) ?
					DEVICE_ACCOUNT_LINK_KINDS.MACHINE_STABLE_PROFILE
				:	DEVICE_ACCOUNT_LINK_KINDS.MACHINE_SIGNATURE,
		});
		return {
			ok: false,
			decision: MACHINE_TRACE_DECISIONS.BLOCKED,
			code: DEVICE_MACHINE_ALREADY_USED,
			message: MACHINE_BLOCK_MESSAGE,
			similarityScore: bestMatch.score,
			matchedFamilies: bestMatch.matchedFamilies,
			matchedTraceId: bestMatch.trace?._id || null,
			machineSignature,
		};
	}

	if (bestMatch?.quarantined || machineSignature.vpnRisk?.review) {
		return {
			ok: true,
			decision: MACHINE_TRACE_DECISIONS.QUARANTINED,
			code: DEVICE_MACHINE_REVIEW,
			message: 'Vote placé en quarantaine pour vérification technique.',
			similarityScore: Math.max(bestMatch?.score || 0, machineSignature.vpnRisk?.review ? 82 : 0),
			matchedFamilies: [
				...(bestMatch?.matchedFamilies || []),
				...(machineSignature.vpnRisk?.review ? machineSignature.vpnRisk.reasons || [] : []),
			],
			matchedTraceId: bestMatch?.trace?._id || null,
			machineSignature,
		};
	}

	return {
		ok: true,
		decision: MACHINE_TRACE_DECISIONS.ACCEPTED,
		code: 'DEVICE_MACHINE_ACCEPTED',
		message: 'Machine signature accepted.',
		similarityScore: bestMatch?.score || 0,
		matchedFamilies: bestMatch?.matchedFamilies || [],
		matchedTraceId: bestMatch?.trace?._id || null,
		machineSignature,
	};
};

const applyMachineDecisionToFraudDecision = ({ fraudDecision, machineDecision }) => {
	if (!fraudDecision || machineDecision?.decision !== MACHINE_TRACE_DECISIONS.QUARANTINED) return fraudDecision;
	fraudDecision.decision = FRAUD_STATUSES.QUARANTINED;
	fraudDecision.code = DEVICE_MACHINE_REVIEW;
	fraudDecision.message = 'Vote placé en quarantaine pour vérification technique.';
	fraudDecision.riskScore = Math.max(
		Number(fraudDecision.riskScore || 0),
		Number(machineDecision.similarityScore || REVIEW_MIN),
	);
	fraudDecision.reasons = [
		...new Set([
			...(Array.isArray(fraudDecision.reasons) ? fraudDecision.reasons : []),
			DEVICE_MACHINE_REVIEW,
			...((machineDecision.matchedFamilies || []).map((entry) => `MACHINE_MATCH_${String(entry).toUpperCase()}`)),
		]),
	];
	return fraudDecision;
};

const commitDeviceTrace = async ({ reservation, opinionId, fraudStatus }) => {
	try {
		const signature = reservation?.machineSignature;
		if (!signature) return null;
		const machineDecision = reservation?.machineDecision || {};
		const decision =
			fraudStatus === FRAUD_STATUSES.QUARANTINED ||
			machineDecision.decision === MACHINE_TRACE_DECISIONS.QUARANTINED ?
				MACHINE_TRACE_DECISIONS.QUARANTINED
			:	MACHINE_TRACE_DECISIONS.ACCEPTED;
		return await DeviceTrace.create({
			surveyId: reservation.surveyId,
			surveyType: reservation.surveyType,
			userId: reservation.userId,
			opinionId,
			machineSignatureVersion: signature.version || MACHINE_SIGNATURE_VERSION,
			hardwareCoreHash: signature.hardwareCoreHash,
			renderingHash: signature.renderingHash,
			environmentHash: signature.environmentHash,
			networkContextHash: signature.networkContextHash,
			browserProofHash: signature.browserProofHash,
			componentHashes: signature.componentHashes || {},
			vpnRisk: signature.vpnRisk || null,
			matchedFamilies: machineDecision.matchedFamilies || [],
			similarityScore: Number(machineDecision.similarityScore || 0),
			decision,
		});
	} catch (error) {
		console.error('DeviceTrace commit failed:', error?.message || error);
		return null;
	}
};

module.exports = {
	MACHINE_SIGNATURE_VERSION,
	DEVICE_MACHINE_ALREADY_USED,
	DEVICE_VPN_BLOCKED,
	DEVICE_MACHINE_REVIEW,
	MACHINE_BLOCK_MESSAGE,
	VPN_BLOCK_MESSAGE,
	buildMachineSignature,
	buildMachineLockCandidates,
	evaluateMachineSignatureVote,
	applyMachineDecisionToFraudDecision,
	commitDeviceTrace,
	compareTrace,
	upsertDeviceAccountLink,
	findLinkedAccountVoteMatch,
	classifyVpnRisk,
};
