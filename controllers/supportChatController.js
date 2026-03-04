/** @format */

const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const {
	normalizeEmail,
	isAnySupportAdminEmail,
} = require('../utils/supportAdminAllowlist');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');
const { isSupportBusinessHours } = require('../utils/supportBusinessHours');

const sanitizeText = (value, max = 4000) =>
	String(value || '')
		.trim()
		.replace(/[<>]/g, '')
		.slice(0, max);

const parseBoolean = (value) =>
	value === true || value === 'true' || value === 1 || value === '1';

const buildConversationRef = () => {
	const year = new Date().getFullYear();
	const random = Math.floor(100000 + Math.random() * 900000);
	return `SUPCHAT-${year}-${random}`;
};

const getPriorityBase = (category) => {
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

const computePriorityScore = (category, openedAt = new Date()) => {
	const waitingMinutes = Math.max(
		0,
		Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000),
	);
	return getPriorityBase(category) + waitingMinutes;
};

const resolveEffectiveIdentity = async (req) => {
	if (!req.userId) {
		const email = normalizeEmail(req.userEmail || req.user?.email || '');
		const role = resolveEffectiveRoleByEmail({
			email,
			fallbackRole: req.userRole || 'user',
		});
		return {
			role,
			email,
			allowlisted: isAnySupportAdminEmail(email),
		};
	}

	const dbUser = await User.findById(req.userId).select('role email').lean();
	const email = normalizeEmail(dbUser?.email || req.userEmail || req.user?.email || '');
	const allowlisted = isAnySupportAdminEmail(email);
	const resolvedRole = resolveEffectiveRoleByEmail({
		email,
		fallbackRole: dbUser?.role || req.userRole || 'user',
	});
	return { role: resolvedRole, email, allowlisted };
};

const buildConversationFilterForUser = (req, role) => {
	if (role === 'support' || role === 'admin') {
		return {};
	}

	if (req.userId) {
		return { clientUserId: req.userId };
	}

	const guestEmail = sanitizeText(req.query?.guestEmail, 180).toLowerCase();
	if (!guestEmail) return { _id: null };
	return { 'guestProfile.email': guestEmail };
};

exports.bootstrapConversation = async (req, res) => {
	try {
		const conversationId = sanitizeText(req.body?.conversationId, 128);
		const forceNewSession = parseBoolean(req.body?.forceNewSession);
		const category = sanitizeText(req.body?.category || 'general', 64);
		const channelPage = sanitizeText(req.body?.channelPage || 'contact', 32);
		const locale = sanitizeText(req.body?.locale || 'fr', 8);
		const initialMessage = sanitizeText(req.body?.initialMessage, 4000);
		const guestName = sanitizeText(req.body?.guestName, 120);
		const guestEmail = sanitizeText(req.body?.guestEmail, 180).toLowerCase();
		const supportOpen = isSupportBusinessHours();

		if (forceNewSession && !supportOpen) {
			return res.status(403).json({
				code: 'SUPPORT_CLOSED_HOURS',
				supportOpen: false,
				message:
					'Le support est actuellement hors horaires ouvrables. Merci de reessayer pendant les heures d ouverture.',
			});
		}

		let conversation = null;
		if (conversationId && !forceNewSession) {
			conversation = await SupportConversation.findById(conversationId);
		}

		if (!conversation) {
			const payload = {
				conversationRef: buildConversationRef(),
				clientUserId: req.userId || null,
				guestProfile: {
					name: guestName || null,
					email: guestEmail || null,
				},
				status: 'waiting',
				category,
				priorityScore: computePriorityScore(category),
				channelPage,
				locale: ['fr', 'en', 'es', 'de'].includes(locale) ? locale : 'fr',
				openedAt: new Date(),
				lastMessageAt: new Date(),
			};
			conversation = await SupportConversation.create(payload);

			if (initialMessage) {
				await SupportMessage.create({
					conversationId: conversation._id,
					senderRole: 'client',
					senderUserId: req.userId || null,
					content: initialMessage,
				});
				conversation.lastMessageAt = new Date();
				await conversation.save();
			}
		}

		const messages = await SupportMessage.find({
			conversationId: conversation._id,
		})
			.sort({ createdAt: 1 })
			.limit(300)
			.lean();

		return res.status(200).json({
			conversation,
			messages,
			supportOpen,
		});
	} catch (error) {
		console.error('supportChat.bootstrapConversation:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.listConversations = async (req, res) => {
	try {
		const page = Math.max(1, Number(req.query?.page || 1));
		const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 30)));
		const skip = (page - 1) * limit;
		const { role } = await resolveEffectiveIdentity(req);
		const filter = buildConversationFilterForUser(req, role);

		if (req.query?.status) filter.status = req.query.status;
		if (req.query?.category) filter.category = req.query.category;

		const [conversations, total] = await Promise.all([
			SupportConversation.find(filter)
				.sort({ priorityScore: -1, openedAt: 1 })
				.skip(skip)
				.limit(limit)
				.populate('assignedAgentId', 'pseudo email role')
				.populate('clientUserId', 'pseudo email role')
				.lean(),
			SupportConversation.countDocuments(filter),
		]);

		return res.status(200).json({
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
			conversations,
		});
	} catch (error) {
		console.error('supportChat.listConversations:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.getConversationMessages = async (req, res) => {
	try {
		const conversationId = req.params.id;
		const conversation = await SupportConversation.findById(conversationId).lean();
		if (!conversation) {
			return res.status(404).json({ message: 'Conversation introuvable.' });
		}

		const identity = await resolveEffectiveIdentity(req);
		const isAgent = identity.role === 'support' || identity.role === 'admin';
		if (isAgent && !identity.allowlisted) {
			return res.status(403).json({
				message: "Accès réservé à l'administrateur support autorisé.",
			});
		}
		const isOwner =
			(req.userId &&
				conversation.clientUserId &&
				String(conversation.clientUserId) === String(req.userId)) ||
			false;
		if (!isAgent && !isOwner) {
			return res.status(403).json({ message: 'Accès interdit.' });
		}

		const messages = await SupportMessage.find({
			conversationId,
		})
			.sort({ createdAt: 1 })
			.limit(500)
			.populate('senderUserId', 'pseudo email role picture')
			.lean();

		return res.status(200).json({ conversation, messages });
	} catch (error) {
		console.error('supportChat.getConversationMessages:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
