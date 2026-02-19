/** @format */

const jwt = require('jsonwebtoken');

const BROWSE_ROOM = 'surveys:browse';
const ownerRoom = (ownerUserId) => `surveys:owner:${String(ownerUserId)}`;

const toIsoOrNull = (value) => {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const createEventId = () =>
	`survey-feed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const extractSocketToken = (socket) => {
	const authToken = socket?.handshake?.auth?.token;
	if (authToken) return String(authToken).trim();

	const queryToken = socket?.handshake?.query?.token;
	if (queryToken) return String(queryToken).trim();

	const authHeader = socket?.handshake?.headers?.authorization;
	if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
		return authHeader.slice(7).trim();
	}

	return null;
};

const extractUserIdFromSocket = (socket) => {
	const token = extractSocketToken(socket);
	if (!token) return null;

	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		return decoded?.id ? String(decoded.id) : null;
	} catch (_error) {
		return null;
	}
};

const buildSurveyFeedPayload = (payload = {}) => {
	const normalizedAction =
		payload.action === 'closed' ? 'closed'
		: payload.action === 'vote' ? 'vote'
		: 'created';
	const normalizedType = payload.type === 'multiple' ? 'multiple' : 'binary';
	const surveyId = String(payload.surveyId || '').trim();
	const ownerUserId = String(payload.ownerUserId || '').trim();
	const rawTotalOpinions = Number(payload.totalOpinions);
	const totalOpinions =
		Number.isFinite(rawTotalOpinions) && rawTotalOpinions >= 0 ?
			Math.trunc(rawTotalOpinions)
		:	null;

	return {
		eventId: String(payload.eventId || createEventId()),
		action: normalizedAction,
		surveyId,
		type: normalizedType,
		explain: payload.explain === false ? false : true,
		isClosed: Boolean(payload.isClosed),
		ownerUserId,
		createdAt: toIsoOrNull(payload.createdAt),
		endedAt: toIsoOrNull(payload.endedAt),
		occurredAt: toIsoOrNull(payload.occurredAt) || new Date().toISOString(),
		totalOpinions,
	};
};

const emitSurveyFeedUpdate = (io, payload = {}) => {
	if (!io) return null;

	const normalized = buildSurveyFeedPayload(payload);
	if (!normalized.surveyId || !normalized.ownerUserId) return null;

	io.to(BROWSE_ROOM).emit('surveys:browse:update', normalized);
	io.to(ownerRoom(normalized.ownerUserId)).emit('surveys:my:update', normalized);
	return normalized;
};

const surveyFeedHandlers = (io) => {
	io.on('connection', (socket) => {
		const userId = extractUserIdFromSocket(socket);
		if (!userId) return;

		socket.join(BROWSE_ROOM);
		socket.join(ownerRoom(userId));
		socket.data.surveyFeedUserId = userId;
	});
};

module.exports = surveyFeedHandlers;
module.exports.emitSurveyFeedUpdate = emitSurveyFeedUpdate;
module.exports.buildSurveyFeedPayload = buildSurveyFeedPayload;
module.exports.rooms = { BROWSE_ROOM, ownerRoom };
