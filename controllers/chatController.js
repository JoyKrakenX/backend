/** @format */

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const mongoose = require('mongoose');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const {
	canManageSurveyByOrganization,
} = require('../services/surveyAuthorizationService');
const { getRedisClient } = require('../services/redisService');
const {
	buildPresencePayloadFromSockets,
	getRedisPresenceSnapshot,
	syncPresenceIndexWithActiveSocketIds,
} = require('../services/chatPresenceService');
const {
	CHAT_ERROR_CODES,
	CHAT_RESTRICTION_STATES,
	buildSurveyModeratorsRoomName,
	buildSurveyUserRoomName,
	getProtectedTargetUserIds,
	getRestrictionsMapForUsers,
	getViewerRestriction,
	isChatModerationError,
	assertViewerCanInteract,
	applyMuteFromMessage,
	applyBanFromMessage,
	createChatModerationError,
} = require('../services/chatModerationService');
const { moderateChatMessage } = require('../services/contentModerationService');
const {
	buildFreshChatMessagePayload,
	formatChatMessagePayload,
	normalizeObjectId,
} = require('../services/chatMessagePayloadService');
const {
	refreshAndEmitBroadcastSnapshot,
	emitBroadcastStatus,
} = require('../services/broadcastRealtimeService');

const getSurveyModelName = (type) =>
	type === 'multiple' ? 'Survey_2' : 'Survey';

const getSurveyModel = (type) => (type === 'multiple' ? Survey_2 : Survey);

const handleChatErrorResponse = (res, error) => {
	if (isChatModerationError(error)) {
		return res.status(error.status).json({
			code: error.code,
			message: error.message,
			moderation: error.moderation || undefined,
		});
	}

	return res
		.status(500)
		.json({ message: 'Erreur serveur', error: error.message });
};

const getOnlineUsersCount = async ({ io, survey, surveyId }) => {
	if (!io) return 0;

	const roomName = `survey-${String(surveyId)}`;
	const organizationId = await resolveSurveyOrganizationId(survey);
	const redis = await getRedisClient();

	if (typeof io.in(roomName).fetchSockets === 'function') {
		try {
			const sockets = await io.in(roomName).fetchSockets();
			const payload = buildPresencePayloadFromSockets(sockets, roomName);
			if (redis && organizationId) {
				await syncPresenceIndexWithActiveSocketIds(redis, {
					organizationId,
					surveyId,
					activeSocketIds: payload.activeSocketIds,
				});
			}
			return Number(payload.onlineCount || 0);
		} catch (error) {
			console.error('getOnlineUsersCount.fetchSockets error:', error?.message || error);
		}
	}

	if (redis && organizationId) {
		const snapshot = await getRedisPresenceSnapshot(redis, {
			organizationId,
			surveyId,
			roomName,
		});
		if (snapshot) {
			return Number(snapshot.onlineCount || 0);
		}
	}

	const presenceStore = io.chatPresence;
	if (presenceStore && presenceStore.get(roomName)) {
		return presenceStore.get(roomName).size;
	}

	const room = io.sockets.adapter.rooms.get(roomName);
	return room ? room.size : 0;
};

// Récupérer les messages d'un sondage
exports.getChatMessages = async (req, res, next) => {
	try {
		const { type, page = 1, limit = 50 } = req.query; //

		const surveyId = req.params.surveyId || req.query.surveyId;

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'surveyId manquant ou invalide' });
		}

		// Déterminer le modèle de sondage
		const surveyObjectId = new mongoose.Types.ObjectId(surveyId);
		const surveyModel = getSurveyModel(type);
		const surveyModelName = getSurveyModelName(type);

		// Vérifier si le sondage existe
		const survey = await surveyModel
			.findById(surveyObjectId)
			.select('theme question isClosed organizationId userId')
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		// Pagination
		const pageNumber = parseInt(page) || 1;
		const limitNumber = parseInt(limit) || 50;
		const skip = (pageNumber - 1) * limitNumber;

		// Récupérer les messages
		const messageFilter = {
			surveyId: surveyObjectId,
			surveyModel: surveyModelName,
		};

		const messages = await ChatMessage.find(messageFilter)
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limitNumber)
			.populate('userId', 'pseudo picture')
			.lean();

		// Inverser l'ordre pour afficher du plus ancien au plus récent
		const reversedMessages = messages.reverse();

		// Enrichir avec les informations utilisateur
		const enrichedMessages = reversedMessages.map((msg) =>
			formatChatMessagePayload(msg, { actorUserId: req.userId }),
		);

		// Compter le total des messages
		const totalMessages = await ChatMessage.countDocuments(messageFilter);
		const organizationId = await resolveSurveyOrganizationId(survey);
		const canModerateChat = await canManageSurveyByOrganization(
			survey,
			req.userId
		);
		const viewerRestriction = await getViewerRestriction({
			surveyId: surveyObjectId,
			surveyModel: surveyModelName,
			userId: req.userId,
		});
		const messageUserIds = canModerateChat ?
			reversedMessages
				.map((msg) => msg.userId?._id || msg.userId || null)
				.filter(Boolean)
		:	[];
		const [protectedTargetUserIds, restrictionMap] = await Promise.all(
			canModerateChat ?
				[
					getProtectedTargetUserIds({ survey, organizationId }),
					getRestrictionsMapForUsers({
						surveyId: surveyObjectId,
						surveyModel: surveyModelName,
						userIds: messageUserIds,
					}),
				]
			:	[new Set(), new Map()]
		);

		const restrictionEntries =
			canModerateChat ?
				Object.fromEntries(restrictionMap.entries())
			:	undefined;
		const protectedIdsPayload =
			canModerateChat ? Array.from(protectedTargetUserIds) : undefined;

		const enrichedMessagesWithModeration = enrichedMessages.map((msg) => {
			if (!canModerateChat) return msg;

			const targetUserId = String(msg.user?.id || msg.userId || '');
			return {
				...msg,
				moderation: {
					isProtectedTarget:
						Boolean(targetUserId) && protectedTargetUserIds.has(targetUserId),
					restriction:
						restrictionMap.get(targetUserId) || {
							state: CHAT_RESTRICTION_STATES.NONE,
							muteUntil: null,
						},
				},
			};
		});
		res.status(200).json({
			messages: enrichedMessagesWithModeration,
			surveyClosed: Boolean(survey.isClosed),
			message:
				survey.isClosed ?
					'Le sondage est clôturé. Le chat est archivé.'
				:	null,
			pagination: {
				currentPage: pageNumber, // <-- utiliser pageNumber
				totalPages: Math.ceil(totalMessages / limitNumber), // <-- utiliser limitNumber
				totalMessages,
				hasMore: totalMessages > skip + limitNumber, // <-- utiliser limitNumber
			},
			surveyInfo: {
				title: survey.theme,
				question: survey.question,
				isClosed: survey.isClosed,
				type: type,
			},
			viewerRestriction,
			capabilities: {
				canModerateChat: Boolean(canModerateChat),
				protectedTargetUserIds: protectedIdsPayload,
			},
			moderationContext:
				canModerateChat ?
					{
						targetRestrictions: restrictionEntries,
					}
				:	undefined,
		});
	} catch (error) {
		console.error('Erreur getChatMessages:', error);
		return handleChatErrorResponse(res, error);
	}
};

// Envoyer un message
exports.sendMessage = async (req, res, next) => {
	try {
		const { surveyId } = req.params;
		const { message, type, replyTo, locale, clientMessageId } = req.body;

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'surveyId manquant ou invalide' });
		}

		if (!message || message.trim().length === 0) {
			return res
				.status(400)
				.json({ message: 'Le message ne peut pas être vide' });
		}

		if (message.length > 500) {
			return res
				.status(400)
				.json({ message: 'Le message est trop long (max 500 caractères)' });
		}

		const surveyObjectId = new mongoose.Types.ObjectId(surveyId);
		const surveyModel = getSurveyModel(type);
		const surveyModelName = getSurveyModelName(type);

		const survey = await surveyModel
			.findById(surveyObjectId)
			.select('isClosed organizationId userId')
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.isClosed) {
			return res.status(403).json({
				message:
					'Le sondage est clôturé. Vous ne pouvez plus envoyer de messages.',
			});
		}

		const organizationId = await resolveSurveyOrganizationId(survey);
		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}
		await assertViewerCanInteract({
			surveyId: surveyObjectId,
			surveyModel: surveyModelName,
			userId: req.userId,
		});

		const moderation = await moderateChatMessage({
			text: message.trim(),
			locale,
			surveyId: surveyObjectId,
			surveyType: type === 'multiple' ? 'multiple' : 'binary',
			surveyModel: surveyModelName,
			userId: req.userId,
			userPseudoSnapshot: req.userPseudo,
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
				surveyId: surveyObjectId,
				surveyModel: surveyModelName,
			})
				.select('_id userId userPseudo message')
				.lean();

			if (!originalMessage) {
				return res.status(404).json({
					message: 'Le message auquel vous répondez est introuvable',
				});
			}

			replyToInfo = {
				messageId: originalMessage._id,
				userId: originalMessage.userId,
				pseudo: originalMessage.userPseudo,
				message: originalMessage.message.substring(0, 100),
			};
		}

		const chatMessage = new ChatMessage({
			surveyId: surveyObjectId,
			surveyModel: surveyModelName,
			userId: req.userId,
			userPseudo: req.userPseudo,
			message: message.trim(),
			isSystemMessage: false,
			replyTo: replyTo || null,
			replyToInfo,
		});

		await chatMessage.save();

		const formattedMessage = buildFreshChatMessagePayload(chatMessage, {
			actorUserId: req.userId,
			userId: req.userId,
			pseudo: req.userPseudo,
			picture: req.user?.picture || null,
		});
		if (clientMessageId) {
			formattedMessage.clientMessageId = String(clientMessageId);
		}

		const io = req.app.get('io');
		io.to(`survey-${surveyId}`).emit('newMessage', formattedMessage);
		emitBroadcastStatus(io, surveyId, {
			reason: 'candidate:new',
			sourceType: 'chat_message',
			sourceId: String(chatMessage._id),
		});
		const replyTargetUserId = normalizeObjectId(replyToInfo?.userId);
		if (replyTargetUserId && replyTargetUserId !== String(req.userId)) {
			io.to(buildSurveyUserRoomName(surveyId, replyTargetUserId)).emit(
				'replyNotification',
				{
					targetUserId: replyTargetUserId,
					fromUser: req.userPseudo || 'Utilisateur',
					message: message.trim(),
					messageId: String(formattedMessage.id || chatMessage._id),
					surveyId: String(surveyId),
				},
			);
		}

		res.status(201).json({
			message: 'Message envoyé',
			chatMessage: formattedMessage,
		});
	} catch (error) {
		console.error('Erreur sendMessage:', error);
		return handleChatErrorResponse(res, error);
	}
};

exports.muteMessageAuthor = async (req, res) => {
	try {
		const { messageId } = req.params;
		const result = await applyMuteFromMessage({
			messageId,
			actorUserId: req.userId,
		});
		const {
			context,
			restriction,
			targetUserId,
			targetUserPseudo,
		} = result;

		const io = req.app.get('io');
		if (io) {
			const payload = {
				messageId: String(context.chatMessage._id),
				surveyId: String(context.chatMessage.surveyId),
				targetUserId,
				targetUserPseudo,
				restriction,
			};
			io.to(buildSurveyUserRoomName(context.chatMessage.surveyId, targetUserId)).emit(
				'chatRestrictionUpdated',
				payload,
			);
			io.to(buildSurveyModeratorsRoomName(context.chatMessage.surveyId)).emit(
				'chatRestrictionUpdated',
				payload,
			);
		}

		return res.status(200).json({
			message: 'Utilisateur mis en sourdine pour 10 minutes.',
			messageId: String(context.chatMessage._id),
			surveyId: String(context.chatMessage.surveyId),
			targetUserId,
			targetUserPseudo,
			restriction,
		});
	} catch (error) {
		console.error('Erreur muteMessageAuthor:', error);
		return handleChatErrorResponse(res, error);
	}
};

exports.banMessageAuthor = async (req, res) => {
	try {
		const { messageId } = req.params;
		const result = await applyBanFromMessage({
			messageId,
			actorUserId: req.userId,
		});
		const {
			context,
			restriction,
			targetUserId,
			targetUserPseudo,
		} = result;

		const io = req.app.get('io');
		if (io) {
			const payload = {
				messageId: String(context.chatMessage._id),
				surveyId: String(context.chatMessage.surveyId),
				targetUserId,
				targetUserPseudo,
				restriction,
			};
			io.to(buildSurveyUserRoomName(context.chatMessage.surveyId, targetUserId)).emit(
				'chatRestrictionUpdated',
				payload,
			);
			io.to(buildSurveyModeratorsRoomName(context.chatMessage.surveyId)).emit(
				'chatRestrictionUpdated',
				payload,
			);
		}

		return res.status(200).json({
			message: 'Utilisateur banni du chat.',
			messageId: String(context.chatMessage._id),
			surveyId: String(context.chatMessage.surveyId),
			targetUserId,
			targetUserPseudo,
			restriction,
		});
	} catch (error) {
		console.error('Erreur banMessageAuthor:', error);
		return handleChatErrorResponse(res, error);
	}
};

exports.deleteMessage = async (req, res, next) => {
	try {
		const { messageId } = req.params;

		if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
			return res.status(400).json({ message: 'messageId manquant ou invalide' });
		}

		const chatMessage = await ChatMessage.findById(messageId)
			.select(
				'_id surveyId surveyModel isSystemMessage userId userPseudo createdAt replyTo replyToInfo'
			)
			.lean();

		if (!chatMessage) {
			return res.status(404).json({ message: 'Message introuvable' });
		}

		if (chatMessage.isSystemMessage) {
			return res.status(403).json({
				message: 'Les messages système ne peuvent pas être supprimés.',
			});
		}

		const surveyModel =
			chatMessage.surveyModel === 'Survey_2' ? Survey_2 : Survey;
		const survey = await surveyModel
			.findById(chatMessage.surveyId)
			.select('theme question isClosed organizationId userId')
			.lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const canModerate = await canManageSurveyByOrganization(survey, req.userId);
		if (!canModerate) {
			return res.status(403).json({
				message:
					'Vous devez être owner ou admin de cette organisation pour modérer le chat.',
			});
		}

		await Promise.all([
			ChatMessage.updateMany(
				{
					surveyId: chatMessage.surveyId,
					surveyModel: chatMessage.surveyModel,
					replyTo: chatMessage._id,
				},
				{
					$set: {
						replyTo: null,
						replyToInfo: null,
					},
				}
			),
			ChatMessage.deleteOne({ _id: chatMessage._id }),
		]);

		const totalMessages = await ChatMessage.countDocuments({
			surveyId: chatMessage.surveyId,
			surveyModel: chatMessage.surveyModel,
		});

		const io = req.app.get('io');
		if (io) {
			io.to(`survey-${String(chatMessage.surveyId)}`).emit('messageDeleted', {
				messageId: String(chatMessage._id),
				surveyId: String(chatMessage.surveyId),
				totalMessages,
			});
			await refreshAndEmitBroadcastSnapshot({
				io,
				surveyId: chatMessage.surveyId,
				reason: 'chat-message-deleted',
			});
		}

		res.status(200).json({
			message: 'Message supprimé',
			messageId: String(chatMessage._id),
			surveyId: String(chatMessage.surveyId),
			totalMessages,
		});
	} catch (error) {
		console.error('Erreur deleteMessage:', error);
		res.status(500).json({ message: 'Erreur serveur', error: error.message });
	}
};
// Gérer les likes/dislikes sur les messages
exports.toggleMessageLike = async (req, res, next) => {
	try {
		const { messageId } = req.params;
		const { action } = req.query; // 'like' ou 'dislike'

		const chatMessage = await ChatMessage.findById(messageId);
		if (!chatMessage) {
			return res.status(404).json({ message: 'Message introuvable' });
		}

		const surveyModel =
			chatMessage.surveyModel === 'Survey_2' ? Survey_2 : Survey;
		const survey = await surveyModel
			.findById(chatMessage.surveyId)
			.select('isClosed organizationId userId')
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}
		if (survey.isClosed) {
			return res.status(403).json({
				message:
					'Le sondage est clôturé. Les réactions sur le chat sont désactivées.',
			});
		}
		const organizationId = await resolveSurveyOrganizationId(survey);
		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.JOIN_CHAT,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}
		await assertViewerCanInteract({
			surveyId: chatMessage.surveyId,
			surveyModel: chatMessage.surveyModel,
			userId: req.userId,
		});

		const userId = req.userId.toString();
		const liked = chatMessage.likes.some((id) => id.toString() === userId);
		const disliked = chatMessage.dislikes.some(
			(id) => id.toString() === userId
		);

		if (action === 'like') {
			if (liked) {
				// Retirer le like
				chatMessage.likes = chatMessage.likes.filter(
					(id) => id.toString() !== userId
				);
			} else {
				// Ajouter le like
				chatMessage.likes.push(userId);
				// Retirer le dislike si présent
				if (disliked) {
					chatMessage.dislikes = chatMessage.dislikes.filter(
						(id) => id.toString() !== userId
					);
				}
			}
		} else if (action === 'dislike') {
			if (disliked) {
				// Retirer le dislike
				chatMessage.dislikes = chatMessage.dislikes.filter(
					(id) => id.toString() !== userId
				);
			} else {
				// Ajouter le dislike
				chatMessage.dislikes.push(userId);
				// Retirer le like si présent
				if (liked) {
					chatMessage.likes = chatMessage.likes.filter(
						(id) => id.toString() !== userId
					);
				}
			}
		} else {
			return res.status(400).json({ message: 'Action invalide' });
		}

		await chatMessage.save();

		const actorUserLiked = chatMessage.likes.some(
			(id) => id.toString() === userId
		);
		const actorUserDisliked = chatMessage.dislikes.some(
			(id) => id.toString() === userId
		);

		// Émettre la mise à jour via Socket.IO
		const io = req.app.get('io');
		io.to(`survey-${chatMessage.surveyId}`).emit('messageUpdated', {
			messageId: chatMessage._id.toString(),
			likeCount: chatMessage.likes.length,
			dislikeCount: chatMessage.dislikes.length,
			actorUserId: userId,
			actorUserLiked,
			actorUserDisliked,
		});

		res.status(200).json({
			message: 'Action enregistrée',
			likeCount: chatMessage.likes.length,
			dislikeCount: chatMessage.dislikes.length,
			userLiked: chatMessage.likes.some((id) => id.toString() === userId),
			userDisliked: chatMessage.dislikes.some((id) => id.toString() === userId),
		});
	} catch (error) {
		console.error('Erreur toggleMessageLike:', error);
		return handleChatErrorResponse(res, error);
	}
};

// Récupérer les statistiques du chat
exports.getChatStats = async (req, res, next) => {
	try {
		const surveyId = req.params.surveyId || req.query.surveyId;
		const { type } = req.query;

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'surveyId manquant ou invalide' });
		}

		const surveyObjectId = new mongoose.Types.ObjectId(surveyId);
		const surveyModel = getSurveyModel(type);
		const surveyModelName = getSurveyModelName(type);
		const survey = await surveyModel
			.findById(surveyObjectId)
			.select('theme isClosed organizationId userId')
			.lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const messageFilter = {
			surveyId: surveyObjectId,
			surveyModel: surveyModelName,
		};
		const io = req.app.get('io');

		const [totalMessages, activeUsersAgg, onlineUsersCount, lastMessage] =
			await Promise.all([
				ChatMessage.countDocuments(messageFilter),
				ChatMessage.aggregate([
					{
						$match: messageFilter,
					},
					{ $group: { _id: '$userId' } },
					{ $count: 'total' },
				]),
				getOnlineUsersCount({
					io,
					survey,
					surveyId: surveyObjectId,
				}),
				ChatMessage.findOne(messageFilter)
					.select('createdAt userPseudo')
					.sort({ createdAt: -1 })
					.lean(),
			]);

		const activeUsers = activeUsersAgg[0]?.total || 0;

		res.status(200).json({
			totalMessages,
			activeUsers,
			onlineUsers: onlineUsersCount,
			lastActivity: lastMessage?.createdAt || null,
			lastMessageUser: lastMessage?.userPseudo || null,
			surveyTitle: survey.theme,
			isClosed: survey.isClosed,
		});
	} catch (error) {
		console.error('Erreur getChatStats:', error);
		res.status(500).json({ message: 'Erreur serveur', error: error.message });
	}
};
