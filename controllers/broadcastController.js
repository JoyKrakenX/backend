/** @format */

const BroadcastCue = require('../models/BroadcastCue');
const {
	resolveBroadcastSurveyContext,
	assertUserCanManageBroadcastSurvey,
	listBroadcastCandidates,
} = require('../services/broadcastCandidateService');
const {
	getBroadcastSnapshot,
	updateBroadcastStudioConfig,
} = require('../services/broadcastSnapshotService');
const {
	createOrApproveBroadcastCue,
	updateBroadcastCueAction,
} = require('../services/broadcastCueService');
const {
	createBroadcastSession,
	getActiveBroadcastSessions,
	revokeBroadcastSession,
	extractBroadcastToken,
	validateBroadcastSessionToken,
	serializeBroadcastSession,
	signBroadcastSessionToken,
} = require('../services/broadcastSessionService');
const {
	refreshAndEmitBroadcastSnapshot,
	emitBroadcastSessionRevoked,
} = require('../services/broadcastRealtimeService');

const parseLimit = (value, fallback = 160) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(1, Math.min(250, Math.round(parsed)));
};

const buildModePayload = ({ snapshot, mode }) => {
	const normalizedMode = String(mode || 'combined');
	const base = {
		survey: snapshot.survey,
		config: snapshot.config,
		updatedAt: snapshot.updatedAt,
	};
	if (normalizedMode === 'results') {
		return {
			...base,
			mode: 'results',
			results: snapshot.results,
		};
	}
	if (normalizedMode === 'chat') {
		return {
			...base,
			mode: 'chat',
			cues: snapshot.cues,
			featuredCue: snapshot.featuredCue,
		};
	}
	return {
		...base,
		mode: 'combined',
		results: snapshot.results,
		cues: snapshot.cues,
		featuredCue: snapshot.featuredCue,
	};
};

const handleControllerError = (res, error, context) => {
	console.error(`broadcast.${context} error:`, error);
	const status = Number(error?.status || 500);
	return res.status(status).json({
		code: error?.code || null,
		message:
			status >= 500 ? 'Erreur serveur broadcast.' : String(error?.message || 'Erreur broadcast.'),
		meta: error?.meta || null,
	});
};

exports.getStudioBootstrap = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const [snapshotBundle, candidates, sessions] = await Promise.all([
			getBroadcastSnapshot({ surveyContext, forceRefresh: true }),
			listBroadcastCandidates({
				surveyContext,
				limit: parseLimit(req.query.limit, 160),
				sort: 'recommended',
			}),
			getActiveBroadcastSessions(surveyContext.survey._id),
		]);
		const sessionPayloads = sessions.map((session) =>
			serializeBroadcastSession({
				session,
				token: signBroadcastSessionToken(session),
				req,
			}),
		);
		return res.status(200).json({
			survey: snapshotBundle.snapshot.survey,
			snapshot: snapshotBundle.snapshot,
			candidates,
			sessions: sessionPayloads,
			config: snapshotBundle.snapshot.config,
		});
	} catch (error) {
		return handleControllerError(res, error, 'getStudioBootstrap');
	}
};

exports.getCandidates = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const candidates = await listBroadcastCandidates({
			surveyContext,
			source: req.query.source || 'all',
			state: req.query.state || 'all',
			search: req.query.search || '',
			sort: req.query.sort || 'recommended',
			limit: parseLimit(req.query.limit, 160),
		});
		return res.status(200).json({ candidates });
	} catch (error) {
		return handleControllerError(res, error, 'getCandidates');
	}
};

exports.createCue = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const cue = await createOrApproveBroadcastCue({
			surveyContext,
			sourceType: req.body?.sourceType,
			sourceId: req.body?.sourceId,
			feature: Boolean(req.body?.feature),
			actorUserId: req.userId,
		});
		await refreshAndEmitBroadcastSnapshot({
			io: req.app.get('io'),
			surveyId: surveyContext.survey._id,
			surveyContext,
			reason: 'cue-approved',
		});
		return res.status(201).json({ cue });
	} catch (error) {
		return handleControllerError(res, error, 'createCue');
	}
};

exports.updateCue = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const cue = await updateBroadcastCueAction({
			surveyContext,
			cueId: req.params.cueId,
			action: req.body?.action,
			airOrder: req.body?.airOrder,
			actorUserId: req.userId,
		});
		await refreshAndEmitBroadcastSnapshot({
			io: req.app.get('io'),
			surveyId: surveyContext.survey._id,
			surveyContext,
			reason: `cue-${String(req.body?.action || 'updated')}`,
		});
		return res.status(200).json({ cue });
	} catch (error) {
		return handleControllerError(res, error, 'updateCue');
	}
};

exports.createSession = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const { session, token } = await createBroadcastSession({
			surveyContext,
			actorUserId: req.userId,
			mode: req.body?.mode,
			outputs: req.body?.outputs,
			ttlMinutes: req.body?.ttlMinutes,
		});
		return res.status(201).json({
			session: serializeBroadcastSession({ session, token, req }),
		});
	} catch (error) {
		return handleControllerError(res, error, 'createSession');
	}
};

exports.revokeSession = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const session = await revokeBroadcastSession({
			sessionId: req.params.sessionId,
			surveyId: surveyContext.survey._id,
			actorUserId: req.userId,
		});
		if (!session) {
			return res.status(404).json({ message: 'Session broadcast introuvable.' });
		}
		emitBroadcastSessionRevoked(req.app.get('io'), session);
		return res.status(200).json({
			session: serializeBroadcastSession({ session }),
		});
	} catch (error) {
		return handleControllerError(res, error, 'revokeSession');
	}
};

exports.updateConfig = async (req, res) => {
	try {
		const surveyContext = await resolveBroadcastSurveyContext(req.params.id);
		await assertUserCanManageBroadcastSurvey({ surveyContext, userId: req.userId });
		const config = await updateBroadcastStudioConfig({
			surveyContext,
			actorUserId: req.userId,
			patch: req.body || {},
		});
		await refreshAndEmitBroadcastSnapshot({
			io: req.app.get('io'),
			surveyId: surveyContext.survey._id,
			surveyContext,
			reason: 'config-updated',
		});
		return res.status(200).json({ config });
	} catch (error) {
		return handleControllerError(res, error, 'updateConfig');
	}
};

exports.getPublicBootstrap = async (req, res) => {
	try {
		const token = extractBroadcastToken(req);
		const { session } = await validateBroadcastSessionToken({ token, output: 'overlay', touch: true });
		const surveyContext = await resolveBroadcastSurveyContext(session.surveyId);
		const { snapshot } = await getBroadcastSnapshot({ surveyContext, forceRefresh: false });
		return res.status(200).json(buildModePayload({ snapshot, mode: session.mode }));
	} catch (error) {
		return handleControllerError(res, error, 'getPublicBootstrap');
	}
};

const buildFeedHandler = (mode) => async (req, res) => {
	try {
		const token = extractBroadcastToken(req);
		const { session } = await validateBroadcastSessionToken({ token, output: 'feed', mode, touch: true });
		const surveyContext = await resolveBroadcastSurveyContext(session.surveyId);
		const { snapshot } = await getBroadcastSnapshot({ surveyContext, forceRefresh: false });
		return res.status(200).json(buildModePayload({ snapshot, mode }));
	} catch (error) {
		return handleControllerError(res, error, `feed.${mode}`);
	}
};

exports.getResultsFeed = buildFeedHandler('results');
exports.getChatFeed = buildFeedHandler('chat');
exports.getCombinedFeed = buildFeedHandler('combined');

