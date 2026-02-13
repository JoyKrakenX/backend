/** @format */

const ChatMessage = require('../models/ChatMessage');

module.exports = (io) => {
	io.on('connection', (socket) => {
		console.log('Utilisateur connecté au chat:', socket.id);

		// Rejoindre une room spécifique à un sondage
		socket.on('joinChatRoom', ({ surveyId, userId, pseudo, type }) => {
			const roomName = `survey-${surveyId}`;
			socket.join(roomName);

			console.log(
				`Utilisateur ${pseudo} (${userId}) a rejoint le chat du sondage ${surveyId}`
			);

			// Notifier les autres utilisateurs (optionnel)
			socket.to(roomName).emit('userJoined', {
				userId,
				pseudo,
				timestamp: new Date(),
				message: `${pseudo} a rejoint le chat`,
			});

			// Envoyer l'historique des 50 derniers messages
			ChatMessage.find({
				surveyId,
				surveyModel: type === 'multiple' ? 'Survey_2' : 'Survey',
			})
				.sort({ createdAt: -1 })
				.limit(50)
				.populate('userId', 'pseudo picture')
				.lean()
				.then((messages) => {
					const formattedMessages = messages.reverse().map((msg) => ({
						...msg,
						id: msg._id,
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
						replyTo: msg.replyTo,
						replyToInfo: msg.replyToInfo,
					}));

					socket.emit('chatHistory', formattedMessages);
				})
				.catch((err) => {
					console.error('Erreur récupération historique:', err);
				});
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

				// Diffuser la mise à jour
				io.to(`survey-${chatMessage.surveyId}`).emit('messageUpdated', {
					messageId: chatMessage._id,
					likeCount: chatMessage.likes.length,
					dislikeCount: chatMessage.dislikes.length,
					userLiked: chatMessage.likes.some((id) => id.toString() === userId),
					userDisliked: chatMessage.dislikes.some(
						(id) => id.toString() === userId
					),
				});
			} catch (error) {
				console.error('Erreur messageReaction:', error);
			}
		});

		// Quitter une room
		socket.on('leaveChatRoom', ({ surveyId, userId, pseudo }) => {
			const roomName = `survey-${surveyId}`;
			socket.leave(roomName);

			// Notifier les autres utilisateurs (optionnel)
			socket.to(roomName).emit('userLeft', {
				userId,
				pseudo,
				timestamp: new Date(),
				message: `${pseudo} a quitté le chat`,
			});

			console.log(
				`Utilisateur ${pseudo} a quitté le chat du sondage ${surveyId}`
			);
		});

		// Déconnexion
		socket.on('disconnect', () => {
			console.log('Utilisateur déconnecté du chat:', socket.id);
		});
	});
};
