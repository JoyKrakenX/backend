/** @format */

const jwt = require('jsonwebtoken');

const BroadcastSession = require('../models/BroadcastSession');

const DEFAULT_SESSION_TTL_MINUTES = 240;

const parseOutputs = (value) => {
	const fallback = ['overlay', 'feed'];
	if (!Array.isArray(value) || !value.length) return fallback;
	const outputs = Array.from(
		new Set(
			value
				.map((entry) => String(entry || '').trim())
				.filter((entry) => ['overlay', 'feed'].includes(entry)),
		),
	);
	return outputs.length ? outputs : fallback;
};

const normalizeMode = (value) => {
	const mode = String(value || '').trim();
	return ['results', 'chat', 'combined'].includes(mode) ? mode : 'combined';
};

const buildSessionName = ({ surveyContext, mode }) => {
	const theme = String(surveyContext?.meta?.theme || 'Broadcast').replace(/^#/, '').trim();
	return `${theme || 'Broadcast'} ${mode}`.trim();
};

const buildBaseUrl = (req) => {
	const forwardedProto = String(req.headers['x-forwarded-proto'] || '').trim();
	const protocol = forwardedProto || req.protocol || 'http';
	return `${protocol}://${req.get('host')}`;
};

const buildBroadcastUrls = ({ req, token, session }) => {
	const baseUrl = buildBaseUrl(req);
	const mode = normalizeMode(session.mode);
	const tokenQuery = `token=${encodeURIComponent(token)}`;
	return {
		overlay:
			session.outputs.includes('overlay')
				? `${baseUrl}/overlay-${mode}.html?${tokenQuery}`
				: null,
		feed:
			session.outputs.includes('feed')
				? `${baseUrl}/api/broadcast/feed/${mode}?${tokenQuery}`
				: null,
		bootstrap: `${baseUrl}/api/broadcast/bootstrap?${tokenQuery}`,
	};
};

const serializeBroadcastSession = ({ session, token = null, req = null }) => {
	const source = typeof session?.toObject === 'function' ? session.toObject() : session || {};
	const payload = {
		id: String(source._id || ''),
		surveyId: String(source.surveyId || ''),
		surveyType: String(source.surveyType || ''),
		mode: normalizeMode(source.mode),
		outputs: parseOutputs(source.outputs),
		name: String(source.name || ''),
		expiresAt: source.expiresAt ? new Date(source.expiresAt).toISOString() : null,
		revokedAt: source.revokedAt ? new Date(source.revokedAt).toISOString() : null,
		createdAt: source.createdAt ? new Date(source.createdAt).toISOString() : null,
		lastAccessedAt: source.lastAccessedAt ? new Date(source.lastAccessedAt).toISOString() : null,
	};
	if (token && req) {
		payload.urls = buildBroadcastUrls({ req, token, session: payload });
	}
	return payload;
};

const signBroadcastSessionToken = (session) => {
	if (!process.env.JWT_SECRET) {
		throw new Error('JWT_SECRET missing');
	}
	return jwt.sign(
		{
			kind: 'broadcast_session',
			sessionId: String(session._id),
			surveyId: String(session.surveyId),
			mode: normalizeMode(session.mode),
			outputs: parseOutputs(session.outputs),
		},
		process.env.JWT_SECRET,
		{
			expiresIn: Math.max(60, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)),
		},
	);
};

const createBroadcastSession = async ({
	surveyContext,
	actorUserId,
	mode,
	outputs,
	ttlMinutes,
} = {}) => {
	const normalizedMode = normalizeMode(mode);
	const normalizedOutputs = parseOutputs(outputs);
	const expiresAt = new Date(
		Date.now() + Math.max(5, Math.min(24 * 60, Number(ttlMinutes || DEFAULT_SESSION_TTL_MINUTES))) * 60000,
	);
	const session = await BroadcastSession.create({
		organizationId: surveyContext.organizationId,
		surveyId: surveyContext.survey._id,
		surveyModel: surveyContext.surveyModel,
		surveyType: surveyContext.surveyKind,
		mode: normalizedMode,
		outputs: normalizedOutputs,
		createdBy: actorUserId,
		expiresAt,
		name: buildSessionName({ surveyContext, mode: normalizedMode }),
	});
	const token = signBroadcastSessionToken(session);
	return { session, token };
};

const getActiveBroadcastSessions = async (surveyId) => {
	return BroadcastSession.find({
		surveyId,
		revokedAt: null,
		expiresAt: { $gt: new Date() },
	})
		.sort({ createdAt: -1 })
		.lean();
};

const revokeBroadcastSession = async ({ sessionId, surveyId, actorUserId }) => {
	const session = await BroadcastSession.findOne({
		_id: sessionId,
		surveyId,
	});
	if (!session) return null;
	if (!session.revokedAt) {
		session.revokedAt = new Date();
		session.revokedBy = actorUserId || null;
		await session.save();
	}
	return session;
};

const extractBroadcastToken = (req) => {
	const authHeader = req.headers.authorization || req.headers.Authorization;
	if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
		return authHeader.slice(7).trim();
	}
	return String(
		req.query?.token || req.headers['x-broadcast-token'] || req.headers['x-overlay-token'] || '',
	).trim();
};

const validateBroadcastSessionToken = async ({ token, output, mode = null, touch = true } = {}) => {
	if (!token) {
		const error = new Error('Broadcast token required');
		error.status = 401;
		throw error;
	}
	let decoded;
	try {
		decoded = jwt.verify(String(token), process.env.JWT_SECRET);
	} catch (_error) {
		const error = new Error('Broadcast token invalid');
		error.status = 401;
		throw error;
	}
	if (decoded?.kind !== 'broadcast_session' || !decoded?.sessionId) {
		const error = new Error('Broadcast token invalid');
		error.status = 401;
		throw error;
	}
	const session = await BroadcastSession.findById(decoded.sessionId);
	if (!session) {
		const error = new Error('Broadcast session not found');
		error.status = 404;
		error.code = 'broadcast_session_not_found';
		throw error;
	}
	if (session.revokedAt) {
		const error = new Error('Broadcast session revoked');
		error.status = 403;
		error.code = 'broadcast_session_revoked';
		error.meta = {
			sessionId: String(session._id),
			revokedAt: new Date(session.revokedAt).toISOString(),
		};
		throw error;
	}
	if (new Date(session.expiresAt).getTime() <= Date.now()) {
		const error = new Error('Broadcast session expired');
		error.status = 403;
		error.code = 'broadcast_session_expired';
		error.meta = {
			sessionId: String(session._id),
			expiresAt: new Date(session.expiresAt).toISOString(),
		};
		throw error;
	}
	if (output && !parseOutputs(session.outputs).includes(output)) {
		const error = new Error('Broadcast output forbidden');
		error.status = 403;
		throw error;
	}
	const requestedMode = mode ? normalizeMode(mode) : null;
	if (requestedMode && requestedMode !== normalizeMode(session.mode)) {
		const error = new Error('Broadcast mode forbidden');
		error.status = 403;
		throw error;
	}
	if (touch) {
		session.lastAccessedAt = new Date();
		await session.save();
	}
	return { session, decoded };
};

module.exports = {
	DEFAULT_SESSION_TTL_MINUTES,
	parseOutputs,
	normalizeMode,
	buildBaseUrl,
	buildBroadcastUrls,
	serializeBroadcastSession,
	signBroadcastSessionToken,
	createBroadcastSession,
	getActiveBroadcastSessions,
	revokeBroadcastSession,
	extractBroadcastToken,
	validateBroadcastSessionToken,
};

