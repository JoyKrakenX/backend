/** @format */

const BroadcastCue = require('../models/BroadcastCue');
const BroadcastStudioConfig = require('../models/BroadcastStudioConfig');
const { getRedisClient } = require('./redisService');
const {
	resolveBroadcastSurveyContext,
	buildBroadcastResultsPayload,
	findCandidateSource,
	serializeCue,
	scoreCandidate,
} = require('./broadcastCandidateService');

const BROADCAST_SNAPSHOT_TTL_SECONDS = 60 * 60 * 6;
const buildSnapshotKey = (surveyId) => `broadcast:snapshot:${String(surveyId)}`;

const DEFAULT_STUDIO_CONFIG = Object.freeze({
	defaultLayout: 'combined',
	position: 'bottom-right',
	tickerEnabled: true,
	tickerSpeed: 18,
	transparency: 0.9,
	maxTextLength: 180,
	featuredDurationSeconds: 16,
	maxTickerItems: 10,
	minimalBranding: true,
	safeMargins: {
		top: 48,
		right: 48,
		bottom: 48,
		left: 48,
	},
});

const toPlainConfig = (configDoc) => {
	const source = typeof configDoc?.toObject === 'function' ? configDoc.toObject() : configDoc || {};
	return {
		defaultLayout: source.defaultLayout || DEFAULT_STUDIO_CONFIG.defaultLayout,
		position: source.position || DEFAULT_STUDIO_CONFIG.position,
		tickerEnabled:
			typeof source.tickerEnabled === 'boolean' ?
				source.tickerEnabled
			: DEFAULT_STUDIO_CONFIG.tickerEnabled,
		tickerSpeed: Number(source.tickerSpeed || DEFAULT_STUDIO_CONFIG.tickerSpeed),
		transparency: Number(source.transparency || DEFAULT_STUDIO_CONFIG.transparency),
		maxTextLength: Number(source.maxTextLength || DEFAULT_STUDIO_CONFIG.maxTextLength),
		featuredDurationSeconds: Number(
			source.featuredDurationSeconds || DEFAULT_STUDIO_CONFIG.featuredDurationSeconds,
		),
		maxTickerItems: Number(source.maxTickerItems || DEFAULT_STUDIO_CONFIG.maxTickerItems),
		minimalBranding:
			typeof source.minimalBranding === 'boolean' ?
				source.minimalBranding
			: DEFAULT_STUDIO_CONFIG.minimalBranding,
		safeMargins: {
			top: Number(source.safeMargins?.top || DEFAULT_STUDIO_CONFIG.safeMargins.top),
			right: Number(source.safeMargins?.right || DEFAULT_STUDIO_CONFIG.safeMargins.right),
			bottom: Number(source.safeMargins?.bottom || DEFAULT_STUDIO_CONFIG.safeMargins.bottom),
			left: Number(source.safeMargins?.left || DEFAULT_STUDIO_CONFIG.safeMargins.left),
		},
		updatedAt: source.updatedAt ? new Date(source.updatedAt).toISOString() : null,
	};
};

const ensureBroadcastStudioConfig = async ({ surveyContext }) => {
	const config = await BroadcastStudioConfig.findOneAndUpdate(
		{ surveyId: surveyContext.survey._id },
		{
			$setOnInsert: {
				organizationId: surveyContext.organizationId,
				surveyModel: surveyContext.surveyModel,
				...DEFAULT_STUDIO_CONFIG,
			},
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	);
	return config;
};

const updateBroadcastStudioConfig = async ({ surveyContext, actorUserId, patch = {} }) => {
	const next = {
		defaultLayout: ['results', 'chat', 'combined'].includes(String(patch.defaultLayout || '')) ? patch.defaultLayout : undefined,
		position: ['bottom', 'bottom-right', 'full'].includes(String(patch.position || '')) ? patch.position : undefined,
		tickerEnabled: typeof patch.tickerEnabled === 'boolean' ? patch.tickerEnabled : undefined,
		tickerSpeed:
			Number.isFinite(Number(patch.tickerSpeed)) ? Math.max(8, Math.min(90, Number(patch.tickerSpeed))) : undefined,
		transparency:
			Number.isFinite(Number(patch.transparency)) ? Math.max(0.2, Math.min(1, Number(patch.transparency))) : undefined,
		maxTextLength:
			Number.isFinite(Number(patch.maxTextLength)) ? Math.max(40, Math.min(320, Number(patch.maxTextLength))) : undefined,
		featuredDurationSeconds:
			Number.isFinite(Number(patch.featuredDurationSeconds)) ? Math.max(6, Math.min(60, Number(patch.featuredDurationSeconds))) : undefined,
		maxTickerItems:
			Number.isFinite(Number(patch.maxTickerItems)) ? Math.max(1, Math.min(25, Number(patch.maxTickerItems))) : undefined,
		minimalBranding: typeof patch.minimalBranding === 'boolean' ? patch.minimalBranding : undefined,
		updatedBy: actorUserId || null,
	};
	if (patch.safeMargins && typeof patch.safeMargins === 'object') {
		next.safeMargins = {
			top: Math.max(0, Math.min(240, Number(patch.safeMargins.top ?? DEFAULT_STUDIO_CONFIG.safeMargins.top))),
			right: Math.max(0, Math.min(240, Number(patch.safeMargins.right ?? DEFAULT_STUDIO_CONFIG.safeMargins.right))),
			bottom: Math.max(0, Math.min(240, Number(patch.safeMargins.bottom ?? DEFAULT_STUDIO_CONFIG.safeMargins.bottom))),
			left: Math.max(0, Math.min(240, Number(patch.safeMargins.left ?? DEFAULT_STUDIO_CONFIG.safeMargins.left))),
		};
	}
	Object.keys(next).forEach((key) => next[key] === undefined && delete next[key]);
	const updated = await BroadcastStudioConfig.findOneAndUpdate(
		{ surveyId: surveyContext.survey._id },
		{
			$set: {
				organizationId: surveyContext.organizationId,
				surveyModel: surveyContext.surveyModel,
				...next,
			},
			$setOnInsert: DEFAULT_STUDIO_CONFIG,
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	);
	return updated;
};

const getSnapshotFromRedis = async (surveyId) => {
	const redis = await getRedisClient();
	if (!redis) return null;
	const raw = await redis.get(buildSnapshotKey(surveyId));
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch (_error) {
		return null;
	}
};

const saveSnapshotToRedis = async (surveyId, snapshot) => {
	const redis = await getRedisClient();
	if (!redis) return;
	await redis.set(
		buildSnapshotKey(surveyId),
		JSON.stringify(snapshot),
		'EX',
		BROADCAST_SNAPSHOT_TTL_SECONDS,
	);
};

const syncApprovedCuesWithSources = async ({ surveyContext }) => {
	const activeCues = await BroadcastCue.find({
		surveyId: surveyContext.survey._id,
		airState: { $in: ['approved', 'featured'] },
		removedAt: null,
		expiredAt: null,
	})
		.sort({ featuredAt: -1, airOrder: 1, approvedAt: -1 })
		.exec();

	if (!activeCues.length) {
		return { cues: [], removedCueIds: [] };
	}

	const sourceCandidates = await Promise.all(
		activeCues.map((cue) =>
			findCandidateSource({
				surveyContext,
				sourceType: cue.sourceType,
				sourceId: cue.sourceId,
			}),
		),
	);

	const now = new Date();
	const removedCueIds = [];
	const authorCounts = new Map();
	const seenTexts = new Set();
	const featuredCues = activeCues.filter((cue) => cue.airState === 'featured').sort((left, right) => {
		const leftTime = left.featuredAt ? new Date(left.featuredAt).getTime() : 0;
		const rightTime = right.featuredAt ? new Date(right.featuredAt).getTime() : 0;
		return rightTime - leftTime;
	});
	const survivingFeaturedCueId = featuredCues[0] ? String(featuredCues[0]._id) : null;

	for (let index = 0; index < activeCues.length; index += 1) {
		const cue = activeCues[index];
		const candidate = sourceCandidates[index];
		if (!candidate) {
			cue.airState = 'removed';
			cue.visibilityState = 'invalidated';
			cue.removedAt = now;
			cue.removedReason = 'source_invalidated';
			await cue.save();
			removedCueIds.push(String(cue._id));
			continue;
		}

		const score = scoreCandidate({ candidate, authorCounts, seenTexts, now: now.getTime() });
		cue.pseudoSnapshot = candidate.pseudoSnapshot;
		cue.textSnapshot = candidate.textSnapshot;
		cue.answerSnapshot = candidate.answerSnapshot;
		cue.sourceCreatedAt = candidate.createdAt;
		cue.engagementSnapshot = candidate.engagement;
		cue.visibilityState = candidate.visibilityState;
		cue.broadcastScore = score;
		if (cue.airState === 'featured' && survivingFeaturedCueId && String(cue._id) !== survivingFeaturedCueId) {
			cue.airState = 'approved';
			cue.featuredAt = null;
			cue.featuredBy = null;
		}
		await cue.save();
	}

	const refreshed = await BroadcastCue.find({
		surveyId: surveyContext.survey._id,
		airState: { $in: ['approved', 'featured'] },
		removedAt: null,
		expiredAt: null,
	})
		.sort({ airState: 1, airOrder: 1, featuredAt: -1, approvedAt: -1 })
		.lean();

	return {
		cues: refreshed,
		removedCueIds,
	};
};

const buildBroadcastSnapshot = async ({ surveyContext }) => {
	const [configDoc, results, cueSync] = await Promise.all([
		ensureBroadcastStudioConfig({ surveyContext }),
		buildBroadcastResultsPayload(surveyContext),
		syncApprovedCuesWithSources({ surveyContext }),
	]);
	const cues = cueSync.cues.map(serializeCue);
	const featuredCue = cues.find((cue) => cue.featured) || null;
	const snapshot = {
		survey: surveyContext.meta,
		results,
		cues,
		featuredCue,
		config: toPlainConfig(configDoc),
		updatedAt: new Date().toISOString(),
	};
	await saveSnapshotToRedis(surveyContext.survey._id, snapshot);
	return {
		snapshot,
		removedCueIds: cueSync.removedCueIds,
	};
};

const getBroadcastSnapshot = async ({ surveyId, surveyContext = null, forceRefresh = false } = {}) => {
	const context = surveyContext || (await resolveBroadcastSurveyContext(surveyId));
	if (!forceRefresh) {
		const cached = await getSnapshotFromRedis(context.survey._id);
		if (cached) return { snapshot: cached, removedCueIds: [] };
	}
	return buildBroadcastSnapshot({ surveyContext: context });
};

module.exports = {
	DEFAULT_STUDIO_CONFIG,
	toPlainConfig,
	ensureBroadcastStudioConfig,
	updateBroadcastStudioConfig,
	getSnapshotFromRedis,
	saveSnapshotToRedis,
	syncApprovedCuesWithSources,
	buildBroadcastSnapshot,
	getBroadcastSnapshot,
};

