/** @format */

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const mongoose = require('mongoose');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { getRedisClient } = require('../services/redisService');

const getSurveyModelName = (type) =>
	type === 'multiple' ? 'Survey_2' : 'Survey';

const getSurveyModel = (type) => (type === 'multiple' ? Survey_2 : Survey);

const getOnlineUsersCount = async ({ io, survey, surveyId }) => {
	if (!io) return 0;

	const roomName = `survey-${String(surveyId)}`;
	const organizationId = await resolveSurveyOrganizationId(survey);
	const redis = await getRedisClient();

	if (redis && organizationId) {
		const key = `presence:org:${String(organizationId)}:survey:${String(surveyId)}:online_users`;
		return Number((await redis.scard(key)) || 0);
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
			.select('theme question isClosed')
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
		const enrichedMessages = reversedMessages.map((msg) => {
			const likeCount = (msg.likes && msg.likes.length) || 0;
			const dislikeCount = (msg.dislikes && msg.dislikes.length) || 0;

			const userLiked = req.userId
				? (msg.likes || []).some(
						(id) => id.toString() === req.userId.toString()
				  )
				: false;

			const userDisliked = req.userId
				? (msg.dislikes || []).some(
						(id) => id.toString() === req.userId.toString()
				  )
				: false;

			return {
				...msg,
				id: msg._id, // Ajout de l'ID
				likeCount,
				dislikeCount,
				userLiked,
				userDisliked,
				replyTo: msg.replyTo, // Assurez-vous d'inclure
				replyToInfo: msg.replyToInfo, // Assurez-vous d'inclure
				user: {
					id: msg.userId ? msg.userId._id : null,
					pseudo: msg.userPseudo || 'Utilisateur',
					picture:
						msg.userId && msg.userId.picture
							? msg.userId.picture
							: 'https://ui-avatars.com/api/?name=' +
							  encodeURIComponent(msg.userPseudo || 'Utilisateur') +
							  '&background=6366f1&color=fff',
				},
			};
		});

		// Compter le total des messages
		const totalMessages = await ChatMessage.countDocuments(messageFilter);
		res.status(200).json({
			messages: enrichedMessages,
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
		});
	} catch (error) {
		console.error('Erreur getChatMessages:', error);
		res.status(500).json({ message: 'Erreur serveur', error: error.message });
	}
};

// Envoyer un message
exports.sendMessage = async (req, res, next) => {
	try {
		const { surveyId } = req.params;
		const { message, type, replyTo } = req.body;

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
		await chatMessage.populate('userId', 'pseudo picture');
		const populatedMessage = chatMessage.toObject();

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
						: 'https://ui-avatars.com/api/?name=' +
						  encodeURIComponent(populatedMessage.userPseudo || 'Utilisateur') +
						  '&background=6366f1&color=fff',
			},
			replyTo: populatedMessage.replyTo,
			replyToInfo: populatedMessage.replyToInfo,
		};

		delete formattedMessage._id;
		delete formattedMessage.__v;

		const io = req.app.get('io');
		io.to(`survey-${surveyId}`).emit('newMessage', formattedMessage);

		res.status(201).json({
			message: 'Message envoyé',
			chatMessage: formattedMessage,
		});
	} catch (error) {
		console.error('Erreur sendMessage:', error);
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
			.select('isClosed')
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
		res.status(500).json({ message: 'Erreur serveur', error: error.message });
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

