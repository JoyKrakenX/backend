/** @format */

const SOCKET_TTL_SECONDS = 75;
const SOCKET_HEARTBEAT_INTERVAL_MS = 25000;

const buildPresenceBaseKey = (organizationId, surveyId) =>
	`presence:org:${String(organizationId)}:survey:${String(surveyId)}`;

const buildPresenceSocketIndexKey = (organizationId, surveyId) =>
	`${buildPresenceBaseKey(organizationId, surveyId)}:socket_ids`;

const buildPresenceSocketKey = (socketId) =>
	`presence:chat_socket:${String(socketId)}`;

const serializePresenceEntry = ({
	roomName,
	organizationId,
	surveyId,
	userId,
	pseudo,
	picture,
}) =>
	JSON.stringify({
		roomName: String(roomName || ''),
		organizationId: String(organizationId || ''),
		surveyId: String(surveyId || ''),
		userId: String(userId || ''),
		pseudo: String(pseudo || 'Utilisateur'),
		picture: picture || null,
	});

const touchSocketPresence = async (
	redis,
	{ organizationId, surveyId, roomName, socketId, userId, pseudo, picture },
) => {
	if (!redis || !organizationId || !surveyId || !socketId || !userId) return null;

	const socketKey = buildPresenceSocketKey(socketId);
	const socketIndexKey = buildPresenceSocketIndexKey(organizationId, surveyId);
	const serialized = serializePresenceEntry({
		roomName,
		organizationId,
		surveyId,
		userId,
		pseudo,
		picture,
	});

	await redis
		.multi()
		.set(socketKey, serialized, 'EX', SOCKET_TTL_SECONDS)
		.sadd(socketIndexKey, String(socketId))
		.expire(socketIndexKey, SOCKET_TTL_SECONDS * 2)
		.exec();

	return {
		socketKey,
		socketIndexKey,
	};
};

const removeSocketPresence = async (
	redis,
	{ organizationId, surveyId, socketId },
) => {
	if (!redis || !organizationId || !surveyId || !socketId) return null;

	const socketKey = buildPresenceSocketKey(socketId);
	const socketIndexKey = buildPresenceSocketIndexKey(organizationId, surveyId);

	await redis.multi().del(socketKey).srem(socketIndexKey, String(socketId)).exec();

	return {
		socketKey,
		socketIndexKey,
	};
};

const getRedisPresenceSnapshot = async (
	redis,
	{ organizationId, surveyId, roomName = null },
) => {
	if (!redis || !organizationId || !surveyId) return null;

	const normalizedSurveyId = String(surveyId);
	const normalizedOrganizationId = String(organizationId);
	const roomId = String(roomName || `survey-${normalizedSurveyId}`);
	const socketIndexKey = buildPresenceSocketIndexKey(
		normalizedOrganizationId,
		normalizedSurveyId,
	);
	const socketIds = await redis.smembers(socketIndexKey);

	if (!socketIds.length) {
		return {
			roomId,
			onlineCount: 0,
			users: [],
		};
	}

	const pipeline = redis.pipeline();
	socketIds.forEach((socketId) => {
		pipeline.get(buildPresenceSocketKey(socketId));
	});
	const results = await pipeline.exec();

	const usersMap = new Map();
	const staleSocketIds = [];

	results.forEach((result, index) => {
		const socketId = String(socketIds[index] || '');
		const [, rawValue] = Array.isArray(result) ? result : [null, null];
		if (!socketId || !rawValue) {
			if (socketId) staleSocketIds.push(socketId);
			return;
		}

		try {
			const parsed = JSON.parse(rawValue);
			if (
				String(parsed?.organizationId || '') !== normalizedOrganizationId ||
				String(parsed?.surveyId || '') !== normalizedSurveyId
			) {
				staleSocketIds.push(socketId);
				return;
			}

			const normalizedUserId = String(parsed?.userId || '').trim();
			if (!normalizedUserId) {
				staleSocketIds.push(socketId);
				return;
			}

			if (!usersMap.has(normalizedUserId)) {
				usersMap.set(normalizedUserId, {
					userId: normalizedUserId,
					pseudo: String(parsed?.pseudo || 'Utilisateur'),
					picture: parsed?.picture || null,
				});
			}
		} catch (_error) {
			staleSocketIds.push(socketId);
		}
	});

	if (staleSocketIds.length) {
		await redis.srem(socketIndexKey, ...staleSocketIds);
	}

	const users = Array.from(usersMap.values());
	return {
		roomId,
		onlineCount: users.length,
		users,
	};
};

module.exports = {
	SOCKET_HEARTBEAT_INTERVAL_MS,
	SOCKET_TTL_SECONDS,
	buildPresenceSocketIndexKey,
	buildPresenceSocketKey,
	getRedisPresenceSnapshot,
	removeSocketPresence,
	touchSocketPresence,
};
