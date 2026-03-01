/** @format */

const jwt = require('jsonwebtoken');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const {
	broadcastQueuePush,
	broadcastClientReplyPush,
} = require('../services/supportPushService');
const {
	normalizeEmail,
	isSupportAdminEmail,
} = require('../utils/supportAdminAllowlist');
const { isBillingExemptEmail } = require('../services/superAdminService');
const { isSupportBusinessHours } = require('../utils/supportBusinessHours');

const categoryWeight = (category) => {
	switch (String(category || '').toLowerCase()) {
		case 'bug':
		case 'technical':
			return 50;
		case 'accessibility':
			return 45;
		case 'legal':
		case 'privacy':
			return 40;
		default:
			return 30;
	}
};

const computePriorityScore = (conversation) => {
	const openedAt = conversation.openedAt || new Date();
	const waitingMinutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000),
	);
	return categoryWeight(conversation.category) + waitingMinutes;
};

module.exports = (supportNamespace) => {
	const AGENTS_ROOM = 'support_agents';
	const agents = new Map();

	const isAgentRole = (role) => role === 'support' || role === 'admin';
	const isAllowlistedAgent = (user) =>
		Boolean(user?.id) &&
		isAgentRole(user?.role) &&
		!isBillingExemptEmail(normalizeEmail(user?.email)) &&
		isSupportAdminEmail(normalizeEmail(user?.email));

	const updateAgentState = (userId, socketId, role) => {
		const state = agents.get(userId) || {
			userId,
			role,
			sockets: new Set(),
			activeConversations: new Set(),
			lastAssignedAt: 0,
		};
		state.sockets.add(socketId);
		state.role = role;
		agents.set(userId, state);
		return state;
	};

	const removeAgentSocket = (userId, socketId) => {
		const state = agents.get(userId);
		if (!state) return;
		state.sockets.delete(socketId);
		if (state.sockets.size === 0) {
			agents.delete(userId);
		}
	};

	const getOnlineAgents = () =>
		Array.from(agents.values()).filter((state) => state.sockets.size > 0);

	const getBestAvailableAgent = () => {
		const onlineAgents = getOnlineAgents();
		if (!onlineAgents.length) return null;

		onlineAgents.sort((a, b) => {
			if (a.activeConversations.size !== b.activeConversations.size) {
				return a.activeConversations.size - b.activeConversations.size;
			}
			return a.lastAssignedAt - b.lastAssignedAt;
		});
		return onlineAgents[0];
	};

	const getQueuePosition = async (conversation) => {
		const waitingConversations = await SupportConversation.find({
			status: 'waiting',
		})
			.sort({ openedAt: 1 })
			.select('_id')
			.lean();

		const index = waitingConversations.findIndex(
			(item) => String(item._id) === String(conversation._id),
		);
		return index >= 0 ? index + 1 : waitingConversations.length + 1;
	};

	const buildQueueUpdatePayload = (conversation, reason) => ({
		conversationId: String(conversation?._id || ''),
		conversationRef: conversation?.conversationRef || '',
		status: conversation?.status || 'waiting',
		category: conversation?.category || 'general',
		lastMessageAt: conversation?.lastMessageAt || new Date(),
		reason,
	});

	const emitQueueUpdate = async (conversation, reason) => {
		const payload = buildQueueUpdatePayload(conversation, reason);
		supportNamespace.to(AGENTS_ROOM).emit('support:queueUpdated', payload);
		try {
			await broadcastQueuePush(payload);
		} catch (error) {
			console.error('support:push broadcast error:', error?.message || error);
		}
	};

	const emitConversationState = async (conversationId) => {
		const conversation = await SupportConversation.findById(conversationId)
			.populate('assignedAgentId', 'pseudo email role')
			.populate('clientUserId', 'pseudo email role')
			.lean();
		if (!conversation) return;

		const queuePosition =
			conversation.status === 'waiting'
				? await getQueuePosition(conversation)
				: null;

		supportNamespace.to(String(conversationId)).emit('support:statusChanged', {
			conversation,
			queuePosition,
			supportOpen: isSupportBusinessHours(),
		});
	};

	const assignConversationToAgent = async (conversationId) => {
		const conversation = await SupportConversation.findById(conversationId);
		if (!conversation || conversation.status === 'closed') return null;

		const bestAgent = getBestAvailableAgent();
		if (!bestAgent) return null;

		conversation.assignedAgentId = bestAgent.userId;
		conversation.status = 'assigned';
		conversation.priorityScore = computePriorityScore(conversation);
		await conversation.save();

		bestAgent.activeConversations.add(String(conversation._id));
		bestAgent.lastAssignedAt = Date.now();

		await emitConversationState(conversation._id);
		supportNamespace.to(String(conversation._id)).emit('support:assigned', {
			conversationId: String(conversation._id),
			agentId: String(bestAgent.userId),
		});

		return bestAgent;
	};

	const maybeCreateFallbackTicket = async (conversation, firstClientMessage) => {
		if (isSupportBusinessHours()) return;
		if (!firstClientMessage) return;

		const existingTicket = await SupportTicket.findOne({
			category: 'support_chat_off_hours',
			subject: { $regex: String(conversation.conversationRef) },
		}).lean();
		if (existingTicket) return;

		const guestName =
			conversation.guestProfile?.name ||
			(conversation.clientUserId ? 'Utilisateur connecte' : 'Visiteur');
		const guestEmail =
			conversation.guestProfile?.email ||
			(conversation.clientUserId ? 'authenticated@surveyapp.local' : 'guest@surveyapp.local');

		await SupportTicket.create({
			ticketRef: `SUP-${new Date().getFullYear()}-${Math.floor(
				100000 + Math.random() * 900000,
			)}`,
			channelPage: conversation.channelPage || 'contact',
			category: 'support_chat_off_hours',
			subject: `Fallback chat ${conversation.conversationRef}`,
			message: firstClientMessage.content,
			name: guestName,
			email: guestEmail,
			locale: conversation.locale || 'fr',
			userId: conversation.clientUserId || null,
			status: 'new',
			priority: 'normal',
		});
	};

	supportNamespace.use(async (socket, next) => {
		try {
			const token = socket.handshake.auth?.token || socket.handshake.query?.token;
			if (!token) {
				socket.user = { role: 'guest', id: null, pseudo: null, email: null };
				return next();
			}

			const decoded = jwt.verify(String(token), process.env.JWT_SECRET);
			let resolvedRole = decoded?.role || 'user';
			let resolvedPseudo = decoded?.pseudo || null;
			let resolvedEmail = normalizeEmail(decoded?.email || null);

			if (decoded?.id) {
				const dbUser = await User.findById(decoded.id)
					.select('role pseudo email')
					.lean();
				if (dbUser) {
					resolvedRole = dbUser.role || resolvedRole;
					resolvedPseudo = dbUser.pseudo || resolvedPseudo;
					resolvedEmail = normalizeEmail(dbUser.email || resolvedEmail);
				}
			}

			if (
				!isBillingExemptEmail(resolvedEmail) &&
				isSupportAdminEmail(resolvedEmail)
			) {
				if (!isAgentRole(resolvedRole)) {
					resolvedRole = 'admin';
				}
			} else if (isAgentRole(resolvedRole)) {
				resolvedRole = 'user';
			}

			socket.user = {
				id: decoded?.id ? String(decoded.id) : null,
				pseudo: resolvedPseudo,
				email: resolvedEmail,
				role: resolvedRole,
			};
			return next();
		} catch (error) {
			socket.user = { role: 'guest', id: null, pseudo: null, email: null };
			return next();
		}
	});

	supportNamespace.on('connection', (socket) => {
		socket.emit('support:presence', {
			onlineAgents: getOnlineAgents().length,
			supportOpen: isSupportBusinessHours(),
		});

		socket.on('support:agentOnline', async () => {
			if (!isAllowlistedAgent(socket.user)) {
				return socket.emit('support:error', {
					message: "Accès réservé à l'administrateur support autorisé.",
				});
			}

			updateAgentState(socket.user.id, socket.id, socket.user.role);
			socket.join(AGENTS_ROOM);
			socket.emit('support:agentReady', { ok: true });

			const waitingConversations = await SupportConversation.find({
				status: 'waiting',
			})
				.sort({ priorityScore: -1, openedAt: 1 })
				.limit(50)
				.lean();

			for (const conversation of waitingConversations) {
				await assignConversationToAgent(conversation._id);
			}

			supportNamespace.emit('support:presence', {
				onlineAgents: getOnlineAgents().length,
				supportOpen: isSupportBusinessHours(),
			});
		});

		socket.on('support:joinConversation', async (payload = {}) => {
			try {
				let conversation = null;
				const conversationId = String(payload.conversationId || '').trim();
				if (conversationId) {
					conversation = await SupportConversation.findById(conversationId);
				}

				if (!conversation) {
					const conversationRef = `SUPCHAT-${new Date().getFullYear()}-${Math.floor(
						100000 + Math.random() * 900000,
					)}`;
					conversation = await SupportConversation.create({
						conversationRef,
						clientUserId: socket.user.id || null,
						guestProfile: {
							name: String(payload.guestName || '').trim() || null,
							email: String(payload.guestEmail || '').trim().toLowerCase() || null,
						},
						status: 'waiting',
						category: String(payload.category || 'general').toLowerCase(),
						channelPage: String(payload.channelPage || 'contact').toLowerCase(),
						locale: ['fr', 'en', 'es', 'de'].includes(payload.locale)
							? payload.locale
							: 'fr',
						openedAt: new Date(),
						lastMessageAt: new Date(),
					});
					conversation.priorityScore = computePriorityScore(conversation);
					await conversation.save();
					await emitQueueUpdate(conversation, 'new_conversation');
				}

				const room = String(conversation._id);
				socket.join(room);
				socket.data.conversationId = room;

				const messages = await SupportMessage.find({ conversationId: conversation._id })
					.sort({ createdAt: 1 })
					.limit(300)
					.lean();

				socket.emit('support:conversationReady', {
					conversation,
					messages,
					queuePosition:
						conversation.status === 'waiting'
							? await getQueuePosition(conversation)
							: null,
					supportOpen: isSupportBusinessHours(),
				});

				if (conversation.status === 'waiting' && isSupportBusinessHours()) {
					await assignConversationToAgent(conversation._id);
				}
			} catch (error) {
				console.error('support:joinConversation error:', error);
				socket.emit('support:error', {
					message: 'Impossible de rejoindre la conversation support.',
				});
			}
		});

		socket.on('support:claimConversation', async ({ conversationId } = {}) => {
			try {
				if (!isAllowlistedAgent(socket.user)) {
					return socket.emit('support:error', {
						message: "Accès réservé à l'administrateur support autorisé.",
					});
				}
				const conversation = await SupportConversation.findById(conversationId);
				if (!conversation) {
					return socket.emit('support:error', {
						message: 'Conversation introuvable.',
					});
				}

				conversation.assignedAgentId = socket.user.id;
				conversation.status = 'assigned';
				conversation.priorityScore = computePriorityScore(conversation);
				await conversation.save();

				const agentState = updateAgentState(
					socket.user.id,
					socket.id,
					socket.user.role,
				);
				agentState.activeConversations.add(String(conversation._id));
				agentState.lastAssignedAt = Date.now();

				await emitConversationState(conversation._id);
				supportNamespace.to(String(conversation._id)).emit('support:assigned', {
					conversationId: String(conversation._id),
					agentId: String(socket.user.id),
				});
				await emitQueueUpdate(conversation, 'assigned');
			} catch (error) {
				console.error('support:claimConversation error:', error);
				socket.emit('support:error', { message: 'Impossible de prendre ce chat.' });
			}
		});

		socket.on('support:sendMessage', async (payload = {}) => {
			try {
				const conversationId =
					String(payload.conversationId || socket.data.conversationId || '').trim();
				const content = String(payload.content || '').trim();
				const senderContext = String(payload.senderContext || '')
					.trim()
					.toLowerCase();
				const clientMessageId = String(payload.clientMessageId || '')
					.trim()
					.slice(0, 120);
				if (!conversationId || !content) return;

				const conversation = await SupportConversation.findById(conversationId);
				if (!conversation) return;

				if (conversation.status === 'closed') {
					return socket.emit('support:error', {
						code: 'CONVERSATION_CLOSED',
						conversationId: String(conversationId),
						message:
							'Cette conversation est cloturee. Vous ne pouvez plus envoyer de message.',
					});
				}

				const allowlistedAgent = isAllowlistedAgent(socket.user);
				let senderRole = allowlistedAgent ? 'agent' : 'client';
				if (senderContext === 'client') {
					senderRole = 'client';
				} else if (senderContext === 'agent') {
					if (!allowlistedAgent) {
						return socket.emit('support:error', {
							message: "Acces reserve a l administrateur support autorise.",
						});
					}
					senderRole = 'agent';
				}
				const senderUserId = socket.user.id || null;

				const message = await SupportMessage.create({
					conversationId,
					senderRole,
					senderUserId,
					content,
				});

				conversation.lastMessageAt = new Date();
				conversation.priorityScore = computePriorityScore(conversation);

				if (senderRole === 'agent') {
					if (!conversation.firstResponseAt) conversation.firstResponseAt = new Date();
					if (conversation.status === 'waiting') conversation.status = 'assigned';
					if (!conversation.assignedAgentId && senderUserId) {
						conversation.assignedAgentId = senderUserId;
					}
				}

				await conversation.save();
				await emitConversationState(conversationId);

				supportNamespace.to(String(conversationId)).emit('support:newMessage', {
					conversationId: String(conversationId),
					message,
					clientMessageId: clientMessageId || null,
				});

				if (senderRole === 'client') {
					await emitQueueUpdate(conversation, 'new_client_message');

					if (!isSupportBusinessHours()) {
						supportNamespace.to(String(conversationId)).emit('support:queued', {
							conversationId: String(conversationId),
							message:
								"Nos agents sont hors horaires. Votre demande reste en file d'attente.",
						});
						await maybeCreateFallbackTicket(conversation, message);
					} else if (conversation.status === 'waiting') {
						await assignConversationToAgent(conversationId);
					}
				} else if (senderRole === 'agent' && conversation.clientUserId) {
					await broadcastClientReplyPush({
						clientUserId: conversation.clientUserId,
						conversationId: String(conversation._id),
						conversationRef: conversation.conversationRef,
						status: conversation.status,
						reason: 'agent_reply',
						lastMessageAt: conversation.lastMessageAt || new Date(),
					});
				}
			} catch (error) {
				console.error('support:sendMessage error:', error);
				socket.emit('support:error', {
					message: "Impossible d'envoyer le message.",
				});
			}
		});

		socket.on('support:typing', ({ conversationId, typing } = {}) => {
			if (!conversationId) return;
			socket.to(String(conversationId)).emit('support:typing', {
				conversationId: String(conversationId),
				typing: Boolean(typing),
				role: isAllowlistedAgent(socket.user) ? 'agent' : 'client',
			});
		});

		socket.on('support:closeConversation', async ({ conversationId } = {}) => {
			try {
				const conversation = await SupportConversation.findById(conversationId);
				if (!conversation) return;

				const isAgent = isAgentRole(socket.user.role);
				if (isAgent && !isAllowlistedAgent(socket.user)) {
					return socket.emit('support:error', {
						message: "Accès réservé à l'administrateur support autorisé.",
					});
				}
				const isOwner =
					socket.user.id &&
					conversation.clientUserId &&
					String(conversation.clientUserId) === String(socket.user.id);
				if (!isAgent && !isOwner) return;

				conversation.status = 'closed';
				conversation.closedAt = new Date();
				await conversation.save();

				if (conversation.assignedAgentId) {
					const agentState = agents.get(String(conversation.assignedAgentId));
					if (agentState) {
						agentState.activeConversations.delete(String(conversation._id));
					}
				}

				await emitQueueUpdate(conversation, 'closed');
				await emitConversationState(conversationId);
				supportNamespace.to(String(conversationId)).emit('support:closed', {
					conversationId: String(conversationId),
					closedAt: conversation.closedAt,
					closedByRole: isAgent ? 'agent' : 'client',
					supportOpen: isSupportBusinessHours(),
					message: 'Ce chat a ete cloture par l admin.',
				});
			} catch (error) {
				console.error('support:closeConversation error:', error);
			}
		});

		socket.on('disconnect', () => {
			if (socket.user?.id && isAgentRole(socket.user.role)) {
				removeAgentSocket(socket.user.id, socket.id);
				supportNamespace.emit('support:presence', {
					onlineAgents: getOnlineAgents().length,
					supportOpen: isSupportBusinessHours(),
				});
			}
		});
	});
};
