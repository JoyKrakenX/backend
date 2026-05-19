/** @format */

const jwt = require('jsonwebtoken');

const Opinion = require('../models/Opinion');
const OpinionFlash = require('../models/Opinion_Flash');
const Opinion2 = require('../models/Opinion_2');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const OrganizationMember = require('../models/OrganizationMember');

const userBrowseRoom = (userId) => `surveys:user:${String(userId)}`;
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

const toUniqueStringArray = (values = []) =>
	[...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];

const buildSurveyFeedPayload = (payload = {}) => {
	const normalizedAction =
		payload.action === 'closed' ? 'closed'
		: payload.action === 'vote' ? 'vote'
		: 'created';
	const normalizedType = payload.type === 'multiple' ? 'multiple' : 'binary';
	const surveyId = String(payload.surveyId || '').trim();
	const ownerUserId = String(payload.ownerUserId || '').trim();
	const organizationId = String(payload.organizationId || '').trim();
	const rawTotalOpinions = Number(payload.totalOpinions);
	const totalOpinions =
		Number.isFinite(rawTotalOpinions) && rawTotalOpinions >= 0
			? Math.trunc(rawTotalOpinions)
			: null;

	return {
		eventId: String(payload.eventId || createEventId()),
		action: normalizedAction,
		surveyId,
		type: normalizedType,
		explain: payload.explain === false ? false : true,
		isClosed: Boolean(payload.isClosed),
		ownerUserId,
		organizationId: organizationId || null,
		createdAt: toIsoOrNull(payload.createdAt),
		endedAt: toIsoOrNull(payload.endedAt),
		occurredAt: toIsoOrNull(payload.occurredAt) || new Date().toISOString(),
		totalOpinions,
		creatorName: String(payload.creatorName || '').trim() || null,
	};
};

const getConnectedUserIds = (io) => {
	const tracker = io?.surveyFeedConnectedUsers;
	if (!tracker || !(tracker instanceof Map)) return [];
	return [...tracker.keys()];
};

const emitToAudience = (io, eventName, payload, userIds = []) => {
	for (const userId of toUniqueStringArray(userIds)) {
		io.to(userBrowseRoom(userId)).emit(eventName, payload);
	}
};

const getOrganizationManagerUserIds = async (organizationId) => {
	const normalizedOrganizationId = String(organizationId || '').trim();
	if (!normalizedOrganizationId) return [];

	try {
		const managers = await OrganizationMember.find({
			organizationId: normalizedOrganizationId,
			role: { $in: ['owner', 'admin'] },
		})
			.select('userId')
			.lean();
		return toUniqueStringArray(
			managers.map((entry) => String(entry?.userId || '').trim()).filter(Boolean),
		);
	} catch (error) {
		console.error(
			'surveyFeed getOrganizationManagerUserIds error:',
			error?.message || error,
		);
		return [];
	}
};

const resolveParticipantIds = async ({ surveyId, type, explain }) => {
	if (!surveyId) return [];
	const isMultiple = type === 'multiple';
	const isFlash = explain === false;

	const OpinionModel =
		isMultiple
			? isFlash
				? Opinion2Flash
				: Opinion2
			: isFlash
				? OpinionFlash
				: Opinion;

	try {
		const participants = await OpinionModel.distinct('userId', {
			surveyId,
		});
		return toUniqueStringArray(participants);
	} catch (error) {
		console.error('surveyFeed resolveParticipantIds error:', error?.message || error);
		return [];
	}
};

const resolveBrowseAudience = async (io, normalizedPayload) => {
	const connectedUserIds = getConnectedUserIds(io);
	if (!connectedUserIds.length) return [];

	const participants = await resolveParticipantIds({
		surveyId: normalizedPayload.surveyId,
		type: normalizedPayload.type,
		explain: normalizedPayload.explain,
	});
	const allowed = new Set(participants);

	return connectedUserIds.filter((userId) => allowed.has(String(userId)));
};

const emitSurveyFeedUpdate = (io, payload = {}) => {
	if (!io) return null;

	const normalized = buildSurveyFeedPayload(payload);
	if (!normalized.surveyId || !normalized.ownerUserId) return null;

	io.to(ownerRoom(normalized.ownerUserId)).emit('surveys:my:update', normalized);

	void (async () => {
		const audience = await resolveBrowseAudience(io, normalized);
		if (!audience.length) return;
		emitToAudience(io, 'surveys:browse:update', normalized, audience);
	})();

	void (async () => {
		if (!normalized.organizationId) return;
		const managerAudience = await getOrganizationManagerUserIds(
			normalized.organizationId,
		);
		if (!managerAudience.length) return;
		emitToAudience(io, 'surveys:org:update', normalized, managerAudience);
	})();

	return normalized;
};

const buildMembershipPayload = (payload = {}) => ({
	eventId: String(payload.eventId || createEventId()),
	occurredAt: toIsoOrNull(payload.occurredAt) || new Date().toISOString(),
	organizationId: String(payload.organizationId || '').trim() || null,
	reason: String(payload.reason || 'updated').trim() || 'updated',
	actorUserId: String(payload.actorUserId || '').trim() || null,
	affectedUserId: String(payload.affectedUserId || '').trim() || null,
	affectedRole: String(payload.affectedRole || '').trim() || null,
});

const emitOrganizationMembershipUpdate = (io, payload = {}) => {
	if (!io) return null;

	const normalized = buildMembershipPayload(payload);
	if (!normalized.organizationId) return null;

	void (async () => {
		const managerUserIds = await getOrganizationManagerUserIds(
			normalized.organizationId,
		);
		const audience = toUniqueStringArray([
			...managerUserIds,
			normalized.affectedUserId,
			normalized.actorUserId,
		]);
		if (!audience.length) return;
		emitToAudience(io, 'organizations:membership:update', normalized, audience);
	})();

	return normalized;
};

const surveyFeedHandlers = (io) => {
	if (!io.surveyFeedConnectedUsers) {
		io.surveyFeedConnectedUsers = new Map();
	}

	io.on('connection', (socket) => {
		const userId = extractUserIdFromSocket(socket);
		if (!userId) return;

		socket.join(userBrowseRoom(userId));
		socket.join(ownerRoom(userId));
		socket.data.surveyFeedUserId = userId;

		const tracker = io.surveyFeedConnectedUsers;
		const currentCount = Number(tracker.get(userId) || 0);
		tracker.set(userId, currentCount + 1);

		socket.on('disconnect', () => {
			const nextCount = Number(tracker.get(userId) || 0) - 1;
			if (nextCount <= 0) {
				tracker.delete(userId);
				return;
			}
			tracker.set(userId, nextCount);
		});
	});
};

module.exports = surveyFeedHandlers;
module.exports.emitSurveyFeedUpdate = emitSurveyFeedUpdate;
module.exports.emitOrganizationMembershipUpdate = emitOrganizationMembershipUpdate;
module.exports.buildSurveyFeedPayload = buildSurveyFeedPayload;
module.exports.rooms = { userBrowseRoom, ownerRoom };
