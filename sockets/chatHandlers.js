/** @format */

const jwt = require('jsonwebtoken');

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const User = require('../models/User');
const { authorizeAction } = require('../services/billing/entitlementService');
const {
	ENTITLEMENT_ACTIONS,
	ENTITLEMENT_DENY_CODES,
} = require('../services/billing/constants');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { getRedisClient } = require('../services/redisService');
const {
	SOCKET_HEARTBEAT_INTERVAL_MS,
	buildPresencePayloadFromSockets,
	getRedisPresenceSnapshot,
	removeSocketPresence,
	syncPresenceIndexWithActiveSocketIds,
	touchSocketPresence,
} = require('../services/chatPresenceService');
const { recordChatPeak } = require('../services/billing/usageService');
const {
	CHAT_ERROR_CODES,
	CHAT_RESTRICTION_STATES,
	buildSurveyModeratorsRoomName,
	buildSurveyUserRoomName,
	getViewerRestriction,
	isChatModerationError,
	assertViewerCanInteract,
	createChatModerationError,
} = require('../services/chatModerationService');
const { moderateChatMessage } = require('../services/contentModerationService');
const {
	buildFreshChatMessagePayload,
	formatChatMessagePayload,
	normalizeObjectId,
} = require('../services/chatMessagePayloadService');
const {
	canManageSurveyByOrganization,
} = require('../services/surveyAuthorizationService');

const buildRoomName = (surveyId) => `survey-${String(surveyId)}`;

const resolveSurveyModelFromType = (type) => (type === 'multiple' ? Survey_2 : Survey);
const resolveSurveyModelFromName = (surveyModelName) =>
	surveyModelName === 'Survey_2' ? Survey_2 : Survey;
const SOCKET_JOIN_CHAT_ENTITLEMENT_TTL_MS = 10 * 1000;

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

const resolveSocketUser = async (socket) => {
	const token = extractSocketToken(socket);
	if (!token) return null;
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) return null;
		const user = await User.findById(decoded.id)
			.select('_id pseudo email role picture defaultOrganizationId')
			.lean();
		if (!user) return null;
		return {
			id: String(user._id),
			pseudo: user.pseudo || decoded.pseudo || 'Utilisateur',
			email: user.email || decoded.email || null,
			role: user.role || decoded.role || 'user',
			picture: user.picture || null,
			defaultOrganizationId: user.defaultOrganizationId || null,
		};
	} catch (_error) {
		return null;
	}
};

const emitSocketChatError = async (
	socket,
	error,
	{ surveyId = null, surveyModel = null, userId = null, clientMessageId = null } = {},
) => {
	if (!isChatModerationError(error)) {
		socket.emit('error', {
			message: error?.message || 'Erreur chat.',
			clientMessageId: clientMessageId || undefined,
		});
		return;
	}

	const payload = {
		code: error.code,
		message: error.message,
	};
	if (error?.moderation) {
		payload.moderation = error.moderation;
	}
	if (clientMessageId) {
		payload.clientMessageId = clientMessageId;
	}

	if (
		userId &&
		surveyId &&
		surveyModel &&
		(error.code === CHAT_ERROR_CODES.MUTED ||
			error.code === CHAT_ERROR_CODES.BANNED)
	) {
		payload.restriction = await getViewerRestriction({
			surveyId,
			surveyModel,
			userId,
		});
	}

	socket.emit('error', payload);
};

const clearSocketJoinChatEntitlement = (socket) => {
	if (socket?.data) {
		socket.data.joinChatEntitlement = null;
	}
};

const getSocketJoinChatEntitlement = async ({
	socket,
	organizationId,
	authUser,
}) => {
	const normalizedOrganizationId = normalizeObjectId(organizationId);
	const cachedEntitlement = socket?.data?.joinChatEntitlement;
	if (
		cachedEntitlement?.organizationId &&
		cachedEntitlement.organizationId === normalizedOrganizationId &&
		Number(cachedEntitlement.expiresAt || 0) > Date.now()
	) {
		return cachedEntitlement.value;
	}

	const entitlement = await authorizeAction({
		action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
		organizationId: normalizedOrganizationId,
		userId: authUser.id,
		userEmail: authUser.email,
	});

	if (socket?.data) {
		socket.data.joinChatEntitlement = {
			organizationId: normalizedOrganizationId,
			expiresAt: Date.now() + SOCKET_JOIN_CHAT_ENTITLEMENT_TTL_MS,
			value: entitlement,
		};
	}

	return entitlement;
};

module.exports = (io) => {
	const roomPresence = new Map();
	io.chatPresence = roomPresence;

	if (!io.__chatAuthMiddlewareApplied) {
		io.__chatAuthMiddlewareApplied = true;
		io.use(async (socket, next) => {
			try {
				socket.data.authUser = await resolveSocketUser(socket);
				return next();
			} catch (_error) {
				socket.data.authUser = null;
				return next();
			}
		});
	}

	const ensureRoomPresence = (roomName) => {
		if (!roomPresence.has(roomName)) {
			roomPresence.set(roomName, new Map());
		}
		return roomPresence.get(roomName);
	};

	const buildLocalPresencePayload = (roomName) => {
		const roomUsers = roomPresence.get(roomName);
		const users =
			roomUsers
				? Array.from(roomUsers.values()).map((entry) => ({
						userId: entry.userId,
						pseudo: entry.pseudo,
						picture: entry.picture || null,
				  	}))
				: [];

		return {
			roomId: roomName,
			onlineCount: users.length,
			users,
		};
	};

	const getAuthoritativeRoomPresencePayload = async (roomName) => {
		if (!roomName || typeof io.in(roomName).fetchSockets !== 'function') {
			return null;
		}

		try {
			const sockets = await io.in(roomName).fetchSockets();
			return buildPresencePayloadFromSockets(sockets, roomName);
		} catch (error) {
			console.error('chat.fetchSockets presence error:', error?.message || error);
			return null;
		}
	};

	const emitRoomPresence = async ({ roomName, organizationId, surveyId }) => {
		const redis = await getRedisClient();
		const authoritativePayload = await getAuthoritativeRoomPresencePayload(roomName);

		if (redis && organizationId && surveyId && authoritativePayload) {
			await syncPresenceIndexWithActiveSocketIds(redis, {
				organizationId,
				surveyId,
				activeSocketIds: authoritativePayload.activeSocketIds,
			});
		}

		if (authoritativePayload) {
			io.to(roomName).emit('onlineUsersState', {
				roomId: authoritativePayload.roomId,
				onlineCount: authoritativePayload.onlineCount,
				users: authoritativePayload.users,
			});
			return;
		}

		const redisPayload = await getRedisPresenceSnapshot(redis, {
			roomName,
			organizationId,
			surveyId,
		});
		io.to(roomName).emit(
			'onlineUsersState',
			redisPayload || buildLocalPresencePayload(roomName),
		);
	};

	const stopSocketPresenceHeartbeat = (socket) => {
		if (socket?.data?.presenceHeartbeat) {
			clearInterval(socket.data.presenceHeartbeat);
			socket.data.presenceHeartbeat = null;
		}
	};

	const startSocketPresenceHeartbeat = (socket) => {
		stopSocketPresenceHeartbeat(socket);
		if (
			!socket?.data?.organizationId ||
			!socket?.data?.surveyId ||
			!socket?.data?.roomName ||
			!socket?.data?.userId
		) {
			return;
		}

		const heartbeat = setInterval(async () => {
			try {
				const redis = await getRedisClient();
				if (!redis) return;
				await touchSocketPresence(redis, {
					organizationId: socket.data.organizationId,
					surveyId: socket.data.surveyId,
					roomName: socket.data.roomName,
					socketId: socket.id,
					userId: socket.data.userId,
					pseudo: socket.data.pseudo,
					picture: socket.data.picture || null,
				});
			} catch (error) {
				console.error('chat.presenceHeartbeat error:', error?.message || error);
			}
		}, SOCKET_HEARTBEAT_INTERVAL_MS);

		if (typeof heartbeat.unref === 'function') {
			heartbeat.unref();
		}
		socket.data.presenceHeartbeat = heartbeat;
	};

	const clearSocketPresence = async (socket) => {
		const roomName = socket.data?.roomName;
		const userId = socket.data?.userId;
		const surveyId = socket.data?.surveyId;
		const organizationId = socket.data?.organizationId;

		if (!roomName || !userId) {
			return null;
		}
		stopSocketPresenceHeartbeat(socket);

		const roomUsers = roomPresence.get(roomName);
		if (!roomUsers) {
			if (organizationId && surveyId) {
				const redis = await getRedisClient();
				await removeSocketPresence(redis, {
					organizationId,
					surveyId,
					socketId: socket.id,
				});
				const snapshot = await getRedisPresenceSnapshot(redis, {
					organizationId,
					surveyId,
					roomName,
				});
				const stillOnline =
					snapshot?.users?.some((entry) => String(entry?.userId || '') === String(userId)) ||
					false;
				return {
					roomName,
					userId,
					pseudo: socket.data?.pseudo || 'Utilisateur',
					isLastSocketForUser: !stillOnline,
					concurrentCount: Number(snapshot?.onlineCount || 0),
					organizationId,
					surveyId,
				};
			}
			return null;
		}

		const userEntry = roomUsers.get(userId);
		if (!userEntry) {
			return null;
		}

		userEntry.sockets.delete(socket.id);
		if (userEntry.sockets.size === 0) {
			roomUsers.delete(userId);
		}
		if (roomUsers.size === 0) {
			roomPresence.delete(roomName);
		}

		let concurrentCount = roomUsers?.size || 0;
		let isLastSocketForUser = userEntry.sockets.size === 0;
		if (organizationId && surveyId) {
			const redis = await getRedisClient();
			await removeSocketPresence(redis, {
				organizationId,
				surveyId,
				socketId: socket.id,
			});
			const snapshot = await getRedisPresenceSnapshot(redis, {
				organizationId,
				surveyId,
				roomName,
			});
			concurrentCount = Number(snapshot?.onlineCount || 0);
			isLastSocketForUser =
				!snapshot?.users?.some(
					(entry) => String(entry?.userId || '') === String(userId),
				);
		}

		return {
			roomName,
			userId,
			pseudo: userEntry.pseudo,
			isLastSocketForUser,
			concurrentCount,
			organizationId,
			surveyId,
		};
	};

	io.on('connection', (socket) => {
		socket.on('joinChatRoom', async ({ surveyId, type, picture } = {}) => {
			try {
				const authUser = socket.data?.authUser;
				if (!authUser?.id) {
					return socket.emit('error', {
						code: 'UNAUTHORIZED',
						message: 'Authentification requise pour rejoindre le chat.',
					});
				}

				if (!surveyId) {
					return socket.emit('error', {
						message: 'surveyId manquant',
					});
				}

				const surveyModel = resolveSurveyModelFromType(type);
				const survey = await surveyModel.findById(surveyId).select('organizationId userId').lean();
				if (!survey) {
					return socket.emit('error', {
						message: 'Sondage introuvable',
					});
				}

				const surveyOrganizationId = await resolveSurveyOrganizationId(survey);
				const canModerateChat = await canManageSurveyByOrganization(
					survey,
					authUser.id,
				);
				const entitlement = await getSocketJoinChatEntitlement({
					socket,
					organizationId: surveyOrganizationId,
					authUser,
				});
				if (!entitlement.allowed) {
					return socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
					});
				}

				const roomName = buildRoomName(surveyId);
				const userRoomName = buildSurveyUserRoomName(surveyId, authUser.id);
				const moderatorRoomName =
					canModerateChat ? buildSurveyModeratorsRoomName(surveyId) : null;

				if (socket.data?.roomName && socket.data.roomName !== roomName) {
					const previousRoomName = socket.data.roomName;
					const previousUserRoomName = socket.data.userRoomName;
					const previousModeratorRoomName = socket.data.moderatorRoomName;
					const previousRemoval = await clearSocketPresence(socket);
					socket.leave(previousRoomName);
					if (previousUserRoomName) {
						socket.leave(previousUserRoomName);
					}
					if (previousModeratorRoomName) {
						socket.leave(previousModeratorRoomName);
					}

					if (previousRemoval?.isLastSocketForUser) {
						socket.to(previousRoomName).emit('userLeft', {
							userId: previousRemoval.userId,
							pseudo: previousRemoval.pseudo || 'Utilisateur',
							timestamp: new Date(),
							message: `${previousRemoval.pseudo || 'Utilisateur'} a quitte le chat`,
						});
					}
					await emitRoomPresence({
						roomName: previousRoomName,
						organizationId: previousRemoval?.organizationId,
						surveyId: previousRemoval?.surveyId,
					});
					clearSocketJoinChatEntitlement(socket);
				}

				socket.join(roomName);
				socket.join(userRoomName);
				if (moderatorRoomName) {
					socket.join(moderatorRoomName);
				}
				socket.data.roomName = roomName;
				socket.data.userRoomName = userRoomName;
				socket.data.moderatorRoomName = moderatorRoomName;
				socket.data.surveyId = String(surveyId);
				socket.data.surveyType = type === 'multiple' ? 'multiple' : 'binary';
				socket.data.organizationId = surveyOrganizationId;
				socket.data.userId = String(authUser.id);
				socket.data.pseudo = authUser.pseudo;
				socket.data.picture = picture || authUser.picture || null;
				socket.data.canModerateChat = canModerateChat;

				const roomUsers = ensureRoomPresence(roomName);
				const normalizedUserId = String(authUser.id);
				const existingEntry = roomUsers.get(normalizedUserId);
				const alreadyTrackedSocket = Boolean(
					existingEntry?.sockets?.has(socket.id),
				);
				const userEntry =
					existingEntry || {
						userId: normalizedUserId,
						pseudo: authUser.pseudo,
						picture: picture || authUser.picture || null,
						sockets: new Set(),
					};

				userEntry.pseudo = authUser.pseudo || userEntry.pseudo;
				userEntry.picture = picture || authUser.picture || userEntry.picture || null;
				if (!alreadyTrackedSocket) {
					userEntry.sockets.add(socket.id);
				}
				roomUsers.set(normalizedUserId, userEntry);

				let beforeUserOnline = false;
				let concurrentCount = roomUsers.size;
				if (surveyOrganizationId && surveyId) {
					const redis = await getRedisClient();
					const beforeSnapshot = await getRedisPresenceSnapshot(redis, {
						organizationId: surveyOrganizationId,
						surveyId,
						roomName,
					});
					beforeUserOnline =
						beforeSnapshot?.users?.some(
							(entry) =>
								String(entry?.userId || '') === normalizedUserId,
						) || false;

					await touchSocketPresence(redis, {
						organizationId: surveyOrganizationId,
						surveyId,
						roomName,
						socketId: socket.id,
						userId: normalizedUserId,
						pseudo: authUser.pseudo,
						picture: userEntry.picture,
					});
					const afterSnapshot = await getRedisPresenceSnapshot(redis, {
						organizationId: surveyOrganizationId,
						surveyId,
						roomName,
					});
					concurrentCount = Number(afterSnapshot?.onlineCount || roomUsers.size);
				}
				startSocketPresenceHeartbeat(socket);

				const isFirstPresenceForUser =
					!alreadyTrackedSocket && !existingEntry && !beforeUserOnline;

				const liveLimit = Number(entitlement?.effectiveQuotas?.chatConcurrent);
				if (
					Number.isFinite(liveLimit) &&
					liveLimit > 0 &&
					concurrentCount > liveLimit
				) {
					const removal = await clearSocketPresence(socket);
					socket.leave(roomName);
					socket.data.roomName = null;
					socket.data.userId = null;
					socket.data.pseudo = null;
					socket.data.picture = null;
					socket.data.organizationId = null;
					socket.data.surveyId = null;
					socket.data.surveyType = null;
					clearSocketJoinChatEntitlement(socket);

					await emitRoomPresence({
						roomName,
						organizationId: removal?.organizationId || surveyOrganizationId,
						surveyId: removal?.surveyId || surveyId,
					});

					return socket.emit('error', {
						code: ENTITLEMENT_DENY_CODES.LIVE_CONCURRENT_LIMIT_REACHED,
						message:
							'Capacite live atteinte pour ce cycle. Ajoutez un Live Event Boost ou passez au plan superieur.',
					});
				}

				if (isFirstPresenceForUser) {
					await recordChatPeak({
						organizationId: surveyOrganizationId,
						roomId: String(surveyId),
						concurrentCount,
						idempotencyKey: `chat-peak:${String(surveyOrganizationId)}:${String(
							surveyId,
						)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
					});

					socket.to(roomName).emit('userJoined', {
						userId: normalizedUserId,
						pseudo: authUser.pseudo,
						timestamp: new Date(),
						message: `${authUser.pseudo} a rejoint le chat`,
					});
				}

				await emitRoomPresence({
					roomName,
					organizationId: surveyOrganizationId,
					surveyId,
				});

				const surveyModelName =
					type === 'multiple' ? 'Survey_2' : 'Survey';
				const viewerRestriction = await getViewerRestriction({
					surveyId,
					surveyModel: surveyModelName,
					userId: authUser.id,
				});
				if (viewerRestriction.state !== CHAT_RESTRICTION_STATES.NONE) {
					socket.emit('chatRestrictionUpdated', {
						surveyId: String(surveyId),
						targetUserId: String(authUser.id),
						targetUserPseudo: authUser.pseudo || 'Utilisateur',
						restriction: viewerRestriction,
					});
				}
			} catch (error) {
				console.error('chat.joinChatRoom error:', error);
				await emitSocketChatError(socket, error);
			}
		});

		socket.on('sendMessage', async (data = {}) => {
			try {
				const authUser = socket.data?.authUser;
				if (!authUser?.id) {
					return socket.emit('error', {
						code: 'UNAUTHORIZED',
						message: 'Authentification requise.',
					});
				}

				const surveyId = socket.data?.surveyId || data.surveyId;
				const type = socket.data?.surveyType || data.type;
				const message = String(data.message || '').trim();
				const replyTo = data.replyTo || null;
				const locale = data.locale || null;
				const clientMessageId =
					String(data.clientMessageId || '').trim() || null;

				if (!message) {
					return socket.emit('error', {
						message: 'Le message ne peut pas etre vide',
						clientMessageId: clientMessageId || undefined,
					});
				}
				if (message.length > 500) {
					return socket.emit('error', {
						message: 'Le message est trop long (max 500 caracteres)',
						clientMessageId: clientMessageId || undefined,
					});
				}

				const surveyModel = resolveSurveyModelFromType(type);
				const survey = await surveyModel.findById(surveyId).select('isClosed organizationId userId').lean();
				if (!survey) {
					return socket.emit('error', {
						message: 'Sondage introuvable',
						clientMessageId: clientMessageId || undefined,
					});
				}
				if (survey.isClosed) {
					return socket.emit('error', {
						message: 'Le sondage est cloture. Vous ne pouvez plus envoyer de messages.',
						clientMessageId: clientMessageId || undefined,
					});
				}

				const surveyOrganizationId =
					socket.data?.organizationId || (await resolveSurveyOrganizationId(survey));
				const entitlement = await getSocketJoinChatEntitlement({
					socket,
					organizationId: surveyOrganizationId,
					authUser,
				});
				if (!entitlement.allowed) {
					return socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
						clientMessageId: clientMessageId || undefined,
					});
				}
				await assertViewerCanInteract({
					surveyId,
					surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
					userId: authUser.id,
				});

				const moderation = await moderateChatMessage({
					text: message,
					locale,
					surveyId,
					surveyType: type === 'multiple' ? 'multiple' : 'binary',
					surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
					userId: authUser.id,
					userPseudoSnapshot: authUser.pseudo,
				});
				if (!moderation.ok) {
					const error = createChatModerationError(
						403,
						CHAT_ERROR_CODES.AUTO_MODERATED,
						'Votre message a ete bloque automatiquement car il contient un contenu a risque.',
					);
					error.moderation = {
						source: moderation.decision.source,
						reasonCodes: moderation.decision.reasonCodes,
						state: moderation.decision.appliedVerdict,
					};
					throw error;
				}

				let replyToInfo = null;
				if (replyTo) {
					const originalMessage = await ChatMessage.findOne({
						_id: replyTo,
						surveyId,
					});

					if (originalMessage) {
						replyToInfo = {
							messageId: originalMessage._id,
							userId: originalMessage.userId,
							pseudo: originalMessage.userPseudo,
							message: originalMessage.message.substring(0, 100),
						};
					}
				}

				const chatMessage = new ChatMessage({
					surveyId,
					surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
					userId: authUser.id,
					userPseudo: authUser.pseudo,
					message,
					isSystemMessage: false,
					replyTo: replyTo || null,
					replyToInfo,
				});

				await chatMessage.save();

				const formattedMessage = buildFreshChatMessagePayload(chatMessage, {
					userId: authUser.id,
					pseudo: authUser.pseudo,
					picture: authUser.picture || socket.data?.picture || null,
				});
				if (clientMessageId) {
					formattedMessage.clientMessageId = clientMessageId;
				}

				io.to(buildRoomName(surveyId)).emit('newMessage', formattedMessage);
				const replyTargetUserId = normalizeObjectId(replyToInfo?.userId);
				if (
					replyTargetUserId &&
					replyTargetUserId !== String(authUser.id)
				) {
					io.to(buildSurveyUserRoomName(surveyId, replyTargetUserId)).emit(
						'replyNotification',
						{
							targetUserId: replyTargetUserId,
							fromUser: authUser.pseudo || 'Utilisateur',
							message,
							messageId: String(formattedMessage.id || chatMessage._id),
							surveyId: String(surveyId),
						},
					);
				}
			} catch (error) {
				console.error('chat.sendMessage error:', error);
				await emitSocketChatError(socket, error, {
					surveyId: socket.data?.surveyId || data?.surveyId || null,
					surveyModel:
						(socket.data?.surveyType || data?.type) === 'multiple' ?
							'Survey_2'
						:	'Survey',
					userId: socket.data?.authUser?.id || null,
					clientMessageId:
						String(data?.clientMessageId || '').trim() || null,
				});
			}
		});

		socket.on('messageReaction', async ({ messageId, action } = {}) => {
			try {
				const authUser = socket.data?.authUser;
				if (!authUser?.id) return;

				const chatMessage = await ChatMessage.findById(messageId);
				if (!chatMessage) return;

				const surveyModel = resolveSurveyModelFromName(chatMessage.surveyModel);
				const survey = await surveyModel
					.findById(chatMessage.surveyId)
					.select('isClosed organizationId userId')
					.lean();
				if (!survey) {
					socket.emit('error', { message: 'Sondage introuvable' });
					return;
				}
				if (survey.isClosed) {
					socket.emit('error', {
						message:
							'Le sondage est cloture. Les reactions sur le chat sont desactivees.',
					});
					return;
				}

				const surveyOrganizationId =
					socket.data?.surveyId === String(chatMessage.surveyId) &&
					socket.data?.organizationId ?
						socket.data.organizationId
					:	await resolveSurveyOrganizationId(survey);
				const entitlement = await getSocketJoinChatEntitlement({
					socket,
					organizationId: surveyOrganizationId,
					authUser,
				});
				if (!entitlement.allowed) {
					socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
					});
					return;
				}
				await assertViewerCanInteract({
					surveyId: chatMessage.surveyId,
					surveyModel: chatMessage.surveyModel,
					userId: authUser.id,
				});

				const userId = String(authUser.id);
				const liked = chatMessage.likes.some((id) => String(id) === userId);
				const disliked = chatMessage.dislikes.some((id) => String(id) === userId);

				if (action === 'like') {
					if (liked) {
						chatMessage.likes = chatMessage.likes.filter((id) => String(id) !== userId);
					} else {
						chatMessage.likes.push(userId);
						if (disliked) {
							chatMessage.dislikes = chatMessage.dislikes.filter(
								(id) => String(id) !== userId,
							);
						}
					}
				} else if (action === 'dislike') {
					if (disliked) {
						chatMessage.dislikes = chatMessage.dislikes.filter((id) => String(id) !== userId);
					} else {
						chatMessage.dislikes.push(userId);
						if (liked) {
							chatMessage.likes = chatMessage.likes.filter(
								(id) => String(id) !== userId,
							);
						}
					}
				}

				await chatMessage.save();

				const actorUserLiked = chatMessage.likes.some((id) => String(id) === userId);
				const actorUserDisliked = chatMessage.dislikes.some((id) => String(id) === userId);

				io.to(buildRoomName(chatMessage.surveyId)).emit('messageUpdated', {
					messageId: String(chatMessage._id),
					likeCount: chatMessage.likes.length,
					dislikeCount: chatMessage.dislikes.length,
					actorUserId: userId,
					actorUserLiked,
					actorUserDisliked,
				});
			} catch (error) {
				console.error('chat.messageReaction error:', error);
				await emitSocketChatError(socket, error, {
					surveyId: socket.data?.surveyId || null,
					surveyModel:
						socket.data?.surveyType === 'multiple' ? 'Survey_2' : 'Survey',
					userId: socket.data?.authUser?.id || null,
				});
			}
		});

		socket.on('leaveChatRoom', async ({ surveyId, pseudo } = {}, acknowledge) => {
			const roomName = socket.data?.roomName || (surveyId ? buildRoomName(surveyId) : null);
			if (!roomName) {
				if (typeof acknowledge === 'function') {
					acknowledge({ ok: true, roomId: null });
				}
				return;
			}

			socket.leave(roomName);
			if (socket.data?.userRoomName) {
				socket.leave(socket.data.userRoomName);
			}
			if (socket.data?.moderatorRoomName) {
				socket.leave(socket.data.moderatorRoomName);
			}
			const removal = await clearSocketPresence(socket);

			if (removal?.isLastSocketForUser) {
				socket.to(roomName).emit('userLeft', {
					userId: removal.userId,
					pseudo: removal.pseudo || pseudo || 'Utilisateur',
					timestamp: new Date(),
					message: `${removal.pseudo || pseudo || 'Utilisateur'} a quitte le chat`,
				});
			}

			await emitRoomPresence({
				roomName,
				organizationId: removal?.organizationId,
				surveyId: removal?.surveyId,
			});

			socket.data.roomName = null;
			socket.data.userRoomName = null;
			socket.data.moderatorRoomName = null;
			socket.data.userId = null;
			socket.data.pseudo = null;
			socket.data.picture = null;
			socket.data.organizationId = null;
			socket.data.surveyId = null;
			socket.data.surveyType = null;
			socket.data.canModerateChat = false;
			clearSocketJoinChatEntitlement(socket);

			if (typeof acknowledge === 'function') {
				acknowledge({
					ok: true,
					roomId: roomName,
					onlineCount: removal?.concurrentCount || 0,
				});
			}
		});

		socket.on('disconnect', async () => {
			const removal = await clearSocketPresence(socket);
			clearSocketJoinChatEntitlement(socket);
			if (removal) {
				if (removal.isLastSocketForUser) {
					socket.to(removal.roomName).emit('userLeft', {
						userId: removal.userId,
						pseudo: removal.pseudo || 'Utilisateur',
						timestamp: new Date(),
						message: `${removal.pseudo || 'Utilisateur'} a quitte le chat`,
					});
				}
				await emitRoomPresence({
					roomName: removal.roomName,
					organizationId: removal.organizationId,
					surveyId: removal.surveyId,
				});
			}
		});
	});
};
