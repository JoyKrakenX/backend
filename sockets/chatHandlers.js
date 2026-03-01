/** @format */

const jwt = require('jsonwebtoken');

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const User = require('../models/User');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { getRedisClient } = require('../services/redisService');
const { recordChatPeak } = require('../services/billing/usageService');

const buildRoomName = (surveyId) => `survey-${String(surveyId)}`;

const resolveSurveyModelFromType = (type) => (type === 'multiple' ? Survey_2 : Survey);
const resolveSurveyModelFromName = (surveyModelName) =>
	surveyModelName === 'Survey_2' ? Survey_2 : Survey;

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

const buildPresenceKeys = (organizationId, surveyId) => {
	const base = `presence:org:${String(organizationId)}:survey:${String(surveyId)}`;
	return {
		counts: `${base}:user_socket_count`,
		online: `${base}:online_users`,
		meta: `${base}:user_meta`,
	};
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

	const incrementRedisPresence = async ({
		organizationId,
		surveyId,
		userId,
		pseudo,
		picture,
	}) => {
		const redis = await getRedisClient();
		if (!redis) return null;
		const keys = buildPresenceKeys(organizationId, surveyId);
		const ttlSeconds = 60 * 60 * 24 * 2;

		const [[, userSocketCount]] = await redis
			.multi()
			.hincrby(keys.counts, String(userId), 1)
			.expire(keys.counts, ttlSeconds)
			.expire(keys.online, ttlSeconds)
			.expire(keys.meta, ttlSeconds)
			.exec();

		if (Number(userSocketCount || 0) <= 1) {
			await redis.multi().sadd(keys.online, String(userId)).exec();
		}

		await redis.hset(
			keys.meta,
			String(userId),
			JSON.stringify({
				userId: String(userId),
				pseudo: String(pseudo || 'Utilisateur'),
				picture: picture || null,
			}),
		);
		const concurrentCount = Number((await redis.scard(keys.online)) || 0);
		return {
			usedRedis: true,
			concurrentCount,
			userSocketCount: Number(userSocketCount || 0),
		};
	};

	const decrementRedisPresence = async ({ organizationId, surveyId, userId }) => {
		const redis = await getRedisClient();
		if (!redis) return null;
		const keys = buildPresenceKeys(organizationId, surveyId);

		const decrementedRaw = await redis.hincrby(keys.counts, String(userId), -1);
		const userSocketCount = Math.max(0, Number(decrementedRaw || 0));
		if (userSocketCount <= 0) {
			await redis
				.multi()
				.hdel(keys.counts, String(userId))
				.srem(keys.online, String(userId))
				.hdel(keys.meta, String(userId))
				.exec();
		}
		const concurrentCount = Number((await redis.scard(keys.online)) || 0);
		return {
			usedRedis: true,
			concurrentCount,
			userSocketCount,
		};
	};

	const buildRedisPresencePayload = async ({ roomName, organizationId, surveyId }) => {
		if (!organizationId || !surveyId) return null;
		const redis = await getRedisClient();
		if (!redis) return null;
		const keys = buildPresenceKeys(organizationId, surveyId);
		const userIds = await redis.smembers(keys.online);
		if (!userIds.length) {
			return {
				roomId: roomName,
				onlineCount: 0,
				users: [],
			};
		}
		const serializedUsers = await redis.hmget(keys.meta, ...userIds);
		const users = userIds.map((userId, index) => {
			const raw = serializedUsers[index];
			if (!raw) {
				return {
					userId: String(userId),
					pseudo: 'Utilisateur',
					picture: null,
				};
			}
			try {
				const parsed = JSON.parse(raw);
				return {
					userId: String(parsed?.userId || userId),
					pseudo: String(parsed?.pseudo || 'Utilisateur'),
					picture: parsed?.picture || null,
				};
			} catch (_error) {
				return {
					userId: String(userId),
					pseudo: 'Utilisateur',
					picture: null,
				};
			}
		});

		return {
			roomId: roomName,
			onlineCount: users.length,
			users,
		};
	};

	const emitRoomPresence = async ({ roomName, organizationId, surveyId }) => {
		const redisPayload = await buildRedisPresencePayload({
			roomName,
			organizationId,
			surveyId,
		});
		io.to(roomName).emit('onlineUsersState', redisPayload || buildLocalPresencePayload(roomName));
	};

	const clearSocketPresence = async (socket) => {
		const roomName = socket.data?.roomName;
		const userId = socket.data?.userId;
		const surveyId = socket.data?.surveyId;
		const organizationId = socket.data?.organizationId;

		if (!roomName || !userId) {
			return null;
		}

		const roomUsers = roomPresence.get(roomName);
		if (!roomUsers) {
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

		const redisUpdate =
			organizationId && surveyId
				? await decrementRedisPresence({
						organizationId,
						surveyId,
						userId,
				  	})
				: null;

		const concurrentCount =
			redisUpdate?.usedRedis
				? Number(redisUpdate.concurrentCount || 0)
				: roomUsers?.size || 0;
		const isLastSocketForUser =
			redisUpdate?.usedRedis
				? Number(redisUpdate.userSocketCount || 0) <= 0
				: userEntry.sockets.size === 0;

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
				const entitlement = await authorizeAction({
					action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
					organizationId: surveyOrganizationId,
					userId: authUser.id,
					userEmail: authUser.email,
				});
				if (!entitlement.allowed) {
					return socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
					});
				}

				const roomName = buildRoomName(surveyId);

				if (socket.data?.roomName && socket.data.roomName !== roomName) {
					const previousRoomName = socket.data.roomName;
					const previousRemoval = await clearSocketPresence(socket);
					socket.leave(previousRoomName);

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
				}

				socket.join(roomName);
				socket.data.roomName = roomName;
				socket.data.surveyId = String(surveyId);
				socket.data.surveyType = type === 'multiple' ? 'multiple' : 'binary';
				socket.data.organizationId = surveyOrganizationId;
				socket.data.userId = String(authUser.id);
				socket.data.pseudo = authUser.pseudo;
				socket.data.picture = picture || authUser.picture || null;

				const roomUsers = ensureRoomPresence(roomName);
				const normalizedUserId = String(authUser.id);
				const existingEntry = roomUsers.get(normalizedUserId);
				const userEntry =
					existingEntry || {
						userId: normalizedUserId,
						pseudo: authUser.pseudo,
						picture: picture || authUser.picture || null,
						sockets: new Set(),
					};

				userEntry.pseudo = authUser.pseudo || userEntry.pseudo;
				userEntry.picture = picture || authUser.picture || userEntry.picture || null;
				userEntry.sockets.add(socket.id);
				roomUsers.set(normalizedUserId, userEntry);

				const redisUpdate =
					surveyOrganizationId && surveyId
						? await incrementRedisPresence({
								organizationId: surveyOrganizationId,
								surveyId,
								userId: normalizedUserId,
								pseudo: authUser.pseudo,
								picture: userEntry.picture,
						  	})
						: null;

				const isFirstPresenceForUser =
					redisUpdate?.usedRedis
						? Number(redisUpdate.userSocketCount || 0) === 1
						: !existingEntry;

				const concurrentCount =
					redisUpdate?.usedRedis
						? Number(redisUpdate.concurrentCount || 0)
						: roomUsers.size;

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
			} catch (error) {
				console.error('chat.joinChatRoom error:', error);
				socket.emit('error', { message: 'Erreur lors de la connexion au chat.' });
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

				if (!message) {
					return socket.emit('error', {
						message: 'Le message ne peut pas etre vide',
					});
				}
				if (message.length > 500) {
					return socket.emit('error', {
						message: 'Le message est trop long (max 500 caracteres)',
					});
				}

				const surveyModel = resolveSurveyModelFromType(type);
				const survey = await surveyModel.findById(surveyId).select('isClosed organizationId userId').lean();
				if (!survey) {
					return socket.emit('error', {
						message: 'Sondage introuvable',
					});
				}
				if (survey.isClosed) {
					return socket.emit('error', {
						message: 'Le sondage est cloture. Vous ne pouvez plus envoyer de messages.',
					});
				}

				const surveyOrganizationId = await resolveSurveyOrganizationId(survey);
				const entitlement = await authorizeAction({
					action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
					organizationId: surveyOrganizationId,
					userId: authUser.id,
					userEmail: authUser.email,
				});
				if (!entitlement.allowed) {
					return socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
					});
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

				const populatedMessage = await ChatMessage.findById(chatMessage._id)
					.populate('userId', 'pseudo picture')
					.lean();

				const formattedMessage = {
					...populatedMessage,
					id: populatedMessage._id,
					likeCount: 0,
					dislikeCount: 0,
					userLiked: false,
					userDisliked: false,
					user: {
						id: populatedMessage.userId ? populatedMessage.userId._id : null,
						pseudo: populatedMessage.userPseudo || 'Utilisateur',
						picture:
							populatedMessage.userId && populatedMessage.userId.picture
								? populatedMessage.userId.picture
								: `https://ui-avatars.com/api/?name=${encodeURIComponent(
										populatedMessage.userPseudo || 'Utilisateur',
								  )}&background=6366f1&color=fff`,
					},
					replyTo: populatedMessage.replyTo,
					replyToInfo: populatedMessage.replyToInfo,
				};

				delete formattedMessage._id;
				delete formattedMessage.__v;

				io.to(buildRoomName(surveyId)).emit('newMessage', formattedMessage);
			} catch (error) {
				console.error('chat.sendMessage error:', error);
				socket.emit('error', { message: "Erreur lors de l'envoi du message" });
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

				const surveyOrganizationId = await resolveSurveyOrganizationId(survey);
				const entitlement = await authorizeAction({
					action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
					organizationId: surveyOrganizationId,
					userId: authUser.id,
					userEmail: authUser.email,
				});
				if (!entitlement.allowed) {
					socket.emit('error', {
						code: entitlement.code,
						message: entitlement.message,
					});
					return;
				}

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
			}
		});

		socket.on('leaveChatRoom', async ({ surveyId, pseudo } = {}) => {
			const roomName = socket.data?.roomName || (surveyId ? buildRoomName(surveyId) : null);
			if (!roomName) return;

			socket.leave(roomName);
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
			socket.data.userId = null;
			socket.data.pseudo = null;
			socket.data.picture = null;
			socket.data.organizationId = null;
			socket.data.surveyId = null;
			socket.data.surveyType = null;
		});

		socket.on('disconnect', async () => {
			const removal = await clearSocketPresence(socket);
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
