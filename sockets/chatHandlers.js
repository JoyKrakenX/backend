/** @format */

const ChatMessage = require('../models/ChatMessage');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');

module.exports = (io) => {
	const roomPresence = new Map();
	io.chatPresence = roomPresence;

	const ensureRoomPresence = (roomName) => {
		if (!roomPresence.has(roomName)) {
			roomPresence.set(roomName, new Map());
		}
		return roomPresence.get(roomName);
	};

	const buildPresencePayload = (roomName) => {
		const roomUsers = roomPresence.get(roomName);
		const users =
			roomUsers ?
				Array.from(roomUsers.values()).map((entry) => ({
					userId: entry.userId,
					pseudo: entry.pseudo,
					picture: entry.picture || null,
				}))
			:	[];

		return {
			roomId: roomName,
			onlineCount: users.length,
			users,
		};
	};

	const emitRoomPresence = (roomName) => {
		io.to(roomName).emit('onlineUsersState', buildPresencePayload(roomName));
	};

	const clearSocketPresence = (socket) => {
		const roomName = socket.data?.roomName;
		const userId = socket.data?.userId;

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
		let isLastSocketForUser = false;

		if (userEntry.sockets.size === 0) {
			roomUsers.delete(userId);
			isLastSocketForUser = true;
		}

		if (roomUsers.size === 0) {
			roomPresence.delete(roomName);
		}

		return {
			roomName,
			userId,
			pseudo: userEntry.pseudo,
			isLastSocketForUser,
		};
	};

	const resolveSurveyModelFromType = (type) =>
		type === 'multiple' ? Survey_2 : Survey;
	const resolveSurveyModelFromName = (surveyModelName) =>
		surveyModelName === 'Survey_2' ? Survey_2 : Survey;

	io.on('connection', (socket) => {
		console.log('Utilisateur connecté au chat:', socket.id);

		// Rejoindre une room spécifique à un sondage
		socket.on('joinChatRoom', ({ surveyId, userId, pseudo, picture }) => {
			if (!surveyId || !userId || !pseudo) return;

			const roomName = `survey-${surveyId}`;

			if (socket.data?.roomName && socket.data.roomName !== roomName) {
				const previousRoomName = socket.data.roomName;
				const previousRemoval = clearSocketPresence(socket);
				socket.leave(previousRoomName);

				if (previousRemoval?.isLastSocketForUser) {
					socket.to(previousRoomName).emit('userLeft', {
						userId: previousRemoval.userId,
						pseudo: previousRemoval.pseudo || 'Utilisateur',
						timestamp: new Date(),
						message: `${previousRemoval.pseudo || 'Utilisateur'} a quitté le chat`,
					});
				}
				emitRoomPresence(previousRoomName);
			}

			socket.join(roomName);
			socket.data.roomName = roomName;
			socket.data.userId = String(userId);
			socket.data.pseudo = pseudo;
			socket.data.picture = picture || null;

			const roomUsers = ensureRoomPresence(roomName);
			const normalizedUserId = String(userId);
			const existingEntry = roomUsers.get(normalizedUserId);
			const isFirstSocketForUser = !existingEntry;
			const userEntry =
				existingEntry || {
					userId: normalizedUserId,
					pseudo,
					picture: picture || null,
					sockets: new Set(),
				};

			userEntry.pseudo = pseudo || userEntry.pseudo;
			userEntry.picture = picture || userEntry.picture || null;
			userEntry.sockets.add(socket.id);
			roomUsers.set(normalizedUserId, userEntry);

			console.log(
				`Utilisateur ${pseudo} (${userId}) a rejoint le chat du sondage ${surveyId}`
			);

			// Notifier les autres utilisateurs (optionnel)
			if (isFirstSocketForUser) {
				socket.to(roomName).emit('userJoined', {
					userId: normalizedUserId,
					pseudo,
					timestamp: new Date(),
					message: `${pseudo} a rejoint le chat`,
				});
			}

			emitRoomPresence(roomName);
		});

		// Gérer l'envoi de message via Socket.IO
		socket.on('sendMessage', async (data) => {
			try {
				const { surveyId, userId, pseudo, message, type, replyTo } = data;

				console.log('📨 Données reçues dans Socket.IO sendMessage:');
				console.log('- replyTo:', replyTo);
				console.log('- Données complètes:', data);

				if (!message || message.trim().length === 0) {
					return socket.emit('error', {
						message: 'Le message ne peut pas être vide',
					});
				}

				const surveyModel = resolveSurveyModelFromType(type);
				const survey = await surveyModel
					.findById(surveyId)
					.select('isClosed')
					.lean();
				if (!survey) {
					return socket.emit('error', {
						message: 'Sondage introuvable',
					});
				}
				if (survey.isClosed) {
					return socket.emit('error', {
						message:
							'Le sondage est clôturé. Vous ne pouvez plus envoyer de messages.',
					});
				}

				// Si replyTo est fourni, vérifier que le message existe
				let replyToInfo = null;
				if (replyTo) {
					const originalMessage = await ChatMessage.findOne({
						_id: replyTo,
						surveyId: surveyId,
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

				// Créer le message dans la base de données AVEC replyTo et replyToInfo
				const chatMessage = new ChatMessage({
					surveyId,
					surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
					userId,
					userPseudo: pseudo,
					message: message.trim(),
					isSystemMessage: false,
					replyTo: replyTo || null, // ← AJOUT
					replyToInfo: replyToInfo, // ← AJOUT
				});

				await chatMessage.save();

				// Récupérer le message avec les infos utilisateur
				const populatedMessage = await ChatMessage.findById(chatMessage._id)
					.populate('userId', 'pseudo picture')
					.lean();

				// Formater le message pour l'envoi
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
								  encodeURIComponent(
										populatedMessage.userPseudo || 'Utilisateur'
								  ) +
								  '&background=6366f1&color=fff',
					},
					// INCLURE replyTo et replyToInfo dans le message émis
					replyTo: populatedMessage.replyTo,
					replyToInfo: populatedMessage.replyToInfo,
				};

				delete formattedMessage._id;
				delete formattedMessage.__v;

				console.log('🚀 Émission Socket.IO - Message formaté:');
				console.log('- replyTo:', formattedMessage.replyTo);
				console.log('- replyToInfo:', formattedMessage.replyToInfo);

				// Diffuser à tous les utilisateurs dans la room
				io.to(`survey-${surveyId}`).emit('newMessage', formattedMessage);
			} catch (error) {
				console.error('Erreur sendMessage Socket:', error);
				socket.emit('error', { message: "Erreur lors de l'envoi du message" });
			}
		});

		// Gérer les likes/dislikes en temps réel
		socket.on('messageReaction', async ({ messageId, userId, action }) => {
			try {
				const chatMessage = await ChatMessage.findById(messageId);
				if (!chatMessage) return;

				const surveyModel = resolveSurveyModelFromName(chatMessage.surveyModel);
				const survey = await surveyModel
					.findById(chatMessage.surveyId)
					.select('isClosed')
					.lean();
				if (!survey) {
					socket.emit('error', { message: 'Sondage introuvable' });
					return;
				}
				if (survey.isClosed) {
					socket.emit('error', {
						message:
							'Le sondage est clôturé. Les réactions sur le chat sont désactivées.',
					});
					return;
				}

				const liked = chatMessage.likes.some((id) => id.toString() === userId);
				const disliked = chatMessage.dislikes.some(
					(id) => id.toString() === userId
				);

				if (action === 'like') {
					if (liked) {
						chatMessage.likes = chatMessage.likes.filter(
							(id) => id.toString() !== userId
						);
					} else {
						chatMessage.likes.push(userId);
						if (disliked) {
							chatMessage.dislikes = chatMessage.dislikes.filter(
								(id) => id.toString() !== userId
							);
						}
					}
				} else if (action === 'dislike') {
					if (disliked) {
						chatMessage.dislikes = chatMessage.dislikes.filter(
							(id) => id.toString() !== userId
						);
					} else {
						chatMessage.dislikes.push(userId);
						if (liked) {
							chatMessage.likes = chatMessage.likes.filter(
								(id) => id.toString() !== userId
							);
						}
					}
				}

				await chatMessage.save();

				const actorUserLiked = chatMessage.likes.some(
					(id) => id.toString() === userId
				);
				const actorUserDisliked = chatMessage.dislikes.some(
					(id) => id.toString() === userId
				);

				// Diffuser la mise à jour
				io.to(`survey-${chatMessage.surveyId}`).emit('messageUpdated', {
					messageId: chatMessage._id.toString(),
					likeCount: chatMessage.likes.length,
					dislikeCount: chatMessage.dislikes.length,
					actorUserId: userId,
					actorUserLiked,
					actorUserDisliked,
				});
			} catch (error) {
				console.error('Erreur messageReaction:', error);
			}
		});

		// Quitter une room
		socket.on('leaveChatRoom', ({ surveyId, userId, pseudo } = {}) => {
			const roomName = socket.data?.roomName || (surveyId ? `survey-${surveyId}` : null);
			if (!roomName) return;

			socket.leave(roomName);
			const removal = clearSocketPresence(socket);

			if (removal?.isLastSocketForUser) {
				socket.to(roomName).emit('userLeft', {
					userId: removal.userId || String(userId || ''),
					pseudo: removal.pseudo || pseudo || 'Utilisateur',
					timestamp: new Date(),
					message: `${removal.pseudo || pseudo || 'Utilisateur'} a quitté le chat`,
				});
			}

			emitRoomPresence(roomName);

			socket.data.roomName = null;
			socket.data.userId = null;
			socket.data.pseudo = null;
			socket.data.picture = null;

			console.log(`Utilisateur ${pseudo || socket.id} a quitté le chat ${roomName}`);
		});

		// Déconnexion
		socket.on('disconnect', () => {
			const removal = clearSocketPresence(socket);
			if (removal) {
				if (removal.isLastSocketForUser) {
					socket.to(removal.roomName).emit('userLeft', {
						userId: removal.userId,
						pseudo: removal.pseudo || 'Utilisateur',
						timestamp: new Date(),
						message: `${removal.pseudo || 'Utilisateur'} a quitté le chat`,
					});
				}
				emitRoomPresence(removal.roomName);
			}

			console.log('Utilisateur déconnecté du chat:', socket.id);
		});
	});
};
