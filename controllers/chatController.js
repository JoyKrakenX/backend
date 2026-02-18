/** @format */

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const mongoose = require('mongoose');

// Récupérer les messages d'un sondage
exports.getChatMessages = async (req, res, next) => {
	try {
		const { type, page = 1, limit = 50 } = req.query; //

		const surveyId = req.params.surveyId || req.query.surveyId;

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'surveyId manquant ou invalide' });
		}

		// Déterminer le modèle de sondage
		const surveyModel = type === 'multiple' ? Survey_2 : Survey;

		// Vérifier si le sondage existe
		const survey = await surveyModel.findById(surveyId);
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		// Vérifier si le sondage est clôturé (pour le chat)
		if (survey.isClosed) {
			return res.status(200).json({
				messages: [],
				surveyClosed: true,
				message: 'Le sondage est clôturé. Le chat est archivé.',
			});
		}

		// Pagination
		const pageNumber = parseInt(page) || 1;
		const limitNumber = parseInt(limit) || 50;
		const skip = (pageNumber - 1) * limitNumber;

		// Récupérer les messages
		const messages = await ChatMessage.find({
			surveyId,
			surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
		})
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
		const totalMessages = await ChatMessage.countDocuments({
			surveyId,
			surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
		});
		res.status(200).json({
			messages: enrichedMessages,
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
		const { message, type, replyTo } = req.body; // Ajout de replyTo

		console.log('📝 Données reçues dans sendMessage:');
		console.log('- message:', message);
		console.log('- replyTo:', replyTo);
		console.log('- type:', type);

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

		// Déterminer le modèle de sondage
		const surveyModel = type === 'multiple' ? Survey_2 : Survey;

		// Vérifier si le sondage existe
		const survey = await surveyModel.findById(surveyId);
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		// Vérifier si le sondage est clôturé
		if (survey.isClosed) {
			return res.status(403).json({
				message:
					'Le sondage est clôturé. Vous ne pouvez plus envoyer de messages.',
			});
		}

		// Si replyTo est fourni, vérifier que le message existe
		let replyToInfo = null;
		if (replyTo) {
			console.log('🔍 Recherche du message original avec ID:', replyTo);
			const originalMessage = await ChatMessage.findOne({
				_id: replyTo,
				surveyId: surveyId,
			});

			if (!originalMessage) {
				console.log('❌ Message original non trouvé');
				return res.status(404).json({
					message: 'Le message auquel vous répondez est introuvable',
				});
			}

			console.log('✅ Message original trouvé:');
			console.log('- Auteur:', originalMessage.userPseudo);
			console.log('- Texte:', originalMessage.message);

			// Stocker les infos du message original
			replyToInfo = {
				messageId: originalMessage._id,
				userId: originalMessage.userId,
				pseudo: originalMessage.userPseudo,
				message: originalMessage.message.substring(0, 100),
			};
		}

		console.log('📋 replyToInfo créé:', replyToInfo);

		// Créer le message
		const chatMessage = new ChatMessage({
			surveyId,
			surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
			userId: req.userId,
			userPseudo: req.userPseudo,
			message: message.trim(),
			isSystemMessage: false,
			replyTo: replyTo || null,
			replyToInfo: replyToInfo,
		});

		console.log('💾 Sauvegarde du message...');
		await chatMessage.save();
		console.log('✅ Message sauvegardé avec ID:', chatMessage._id);

		// Populate pour obtenir les infos utilisateur
		const populatedMessage = await ChatMessage.findById(chatMessage._id)
			.populate('userId', 'pseudo picture')
			.lean();

		console.log('📦 Message peuplé récupéré:');
		console.log('- replyTo dans DB:', populatedMessage.replyTo);
		console.log('- replyToInfo dans DB:', populatedMessage.replyToInfo);

		// Formater la réponse
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
			// IMPORTANT : Inclure explicitement replyTo et replyToInfo
			replyTo: populatedMessage.replyTo,
			replyToInfo: populatedMessage.replyToInfo,
		};

		delete formattedMessage._id;
		delete formattedMessage.__v;

		console.log('🚀 Émission Socket.IO - Message formaté:');
		console.log('- replyTo:', formattedMessage.replyTo);
		console.log('- replyToInfo:', formattedMessage.replyToInfo);

		// Émettre l'événement Socket.IO
		const io = req.app.get('io');
		io.to(`survey-${surveyId}`).emit('newMessage', formattedMessage);

		console.log('📤 Événement newMessage émis');

		res.status(201).json({
			message: 'Message envoyé',
			chatMessage: formattedMessage,
		});
	} catch (error) {
		console.error('❌ Erreur sendMessage:', error);
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
		const { type } = req.query; // <-- récupérer type depuis la query

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'surveyId manquant ou invalide' });
		}

		const surveyModel = type === 'multiple' ? Survey_2 : Survey;
		const survey = await surveyModel.findById(surveyId).lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		// Compter les messages
		const totalMessages = await ChatMessage.countDocuments({
			surveyId,
			surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
		});

		// Compter les utilisateurs actifs (distincts - ont posté au moins un message)
		const activeUsersAgg = await ChatMessage.aggregate([
			{
				$match: {
					surveyId: surveyId,
					surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
				},
			},
			{ $group: { _id: '$userId' } },
			{ $count: 'total' },
		]);
		const activeUsers = activeUsersAgg[0]?.total || 0;

		// Nombre d'utilisateurs connectés dans la room Socket.IO (en ligne)
		let onlineUsersCount = 0;
		const io = req.app.get('io');
		if (io) {
			const roomName = `survey-${surveyId}`;
			const presenceStore = io.chatPresence;
			if (presenceStore && presenceStore.get(roomName)) {
				onlineUsersCount = presenceStore.get(roomName).size;
			} else {
				const room = io.sockets.adapter.rooms.get(roomName);
				onlineUsersCount = room ? room.size : 0;
			}
		}

		// Dernier message
		const lastMessage = await ChatMessage.findOne({
			surveyId,
			surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
		})
			.sort({ createdAt: -1 })
			.populate('userId', 'pseudo')
			.lean();

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
