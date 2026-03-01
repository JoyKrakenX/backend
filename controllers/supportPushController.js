/** @format */

const {
	canSendPush,
	getPublicKey,
	upsertSubscription,
	unsubscribe,
	unsubscribeChannels,
	unsubscribeAll,
	listUserSubscriptions,
	getDefaultChannelForRole,
	isAllowedChannelForRole,
	normalizeLocale,
	CHANNELS,
} = require('../services/supportPushService');
const User = require('../models/User');
const {
	normalizeEmail,
	isSupportAdminEmail,
} = require('../utils/supportAdminAllowlist');
const { isBillingExemptEmail } = require('../services/superAdminService');

const createUserError = (message, status = 400) => {
	const error = new Error(message);
	error.status = status;
	return error;
};

const mapPushError = (error, fallbackMessage = 'Service push indisponible.') => {
	const status = Number(error?.status || 503);
	const message = String(error?.message || fallbackMessage);
	return { status, message };
};

const normalizeRole = (role) =>
	role === 'support' || role === 'admin' ? role : 'user';

const parseRequestedChannels = (body = {}, role, { useDefault = true } = {}) => {
	const list = [];
	if (Array.isArray(body.channels)) list.push(...body.channels);

	const single = String(body.channel || '').trim();
	if (single) list.push(single);

	const normalized = Array.from(
		new Set(
			list
				.map((item) => String(item || '').trim())
				.filter(Boolean),
		),
	);

	if (normalized.length) return normalized;
	return useDefault ? [getDefaultChannelForRole(role)] : [];
};

const resolveEffectiveIdentity = async (userId, fallbackRole, fallbackEmail) => {
	if (!userId) {
		let role = normalizeRole(fallbackRole);
		const email = normalizeEmail(fallbackEmail);
		const allowlisted = !isBillingExemptEmail(email) && isSupportAdminEmail(email);
		if (allowlisted && role !== 'support' && role !== 'admin') {
			role = 'admin';
		}
		return {
			role: role === 'support' || role === 'admin' ? (allowlisted ? role : 'user') : role,
			email,
			allowlisted,
		};
	}

	const dbUser = await User.findById(userId).select('role email').lean();
	let role = normalizeRole(dbUser?.role || fallbackRole);
	const email = normalizeEmail(dbUser?.email || fallbackEmail);
	const allowlisted = !isBillingExemptEmail(email) && isSupportAdminEmail(email);
	if (allowlisted && role !== 'support' && role !== 'admin') {
		role = 'admin';
	}
	return {
		role: role === 'support' || role === 'admin' ? (allowlisted ? role : 'user') : role,
		email,
		allowlisted,
	};
};

exports.getPublicKey = async (_req, res) => {
	try {
		if (!canSendPush()) {
			return res.status(503).json({
				message: 'Les notifications push ne sont pas configurees.',
			});
		}
		return res.status(200).json({
			publicKey: getPublicKey(),
		});
	} catch (error) {
		const mapped = mapPushError(error);
		return res.status(mapped.status).json({ message: mapped.message });
	}
};

exports.subscribe = async (req, res) => {
	try {
		if (!req.userId || !req.userRole) {
			throw createUserError('Authentification requise.', 401);
		}

		const subscription = req.body?.subscription;
		if (!subscription || typeof subscription !== 'object') {
			throw createUserError('Abonnement push invalide.', 400);
		}

		const identity = await resolveEffectiveIdentity(
			req.userId,
			req.userRole,
			req.userEmail || req.user?.email,
		);

		const requestedChannels = parseRequestedChannels(req.body, identity.role);
		if (!requestedChannels.length) {
			throw createUserError('Aucun canal push valide.', 400);
		}

		const invalidChannel = requestedChannels.find(
			(channel) => !isAllowedChannelForRole(identity.role, channel),
		);
		if (invalidChannel) {
			throw createUserError('Canal push invalide pour le role courant.', 400);
		}

		if (
			requestedChannels.includes(CHANNELS.SUPPORT_QUEUE) &&
			!identity.allowlisted
		) {
			throw createUserError(
				'Acces reserve a l administrateur support autorise.',
				403,
			);
		}

		const saved = await upsertSubscription({
			userId: req.userId,
			role: identity.role,
			channels: requestedChannels,
			subscription,
			userAgent: req.headers['user-agent'] || null,
			platform: req.body?.platform || null,
			deviceLabel: req.body?.deviceLabel || null,
			locale: normalizeLocale(req.body?.locale),
		});

		return res.status(200).json({
			message: 'Abonnement push active.',
			subscription: {
				id: saved?._id || null,
				endpoint: saved?.endpoint || null,
				channel: saved?.channel || requestedChannels[0],
				channels: Array.isArray(saved?.channels) && saved.channels.length ?
						saved.channels
					:	[saved?.channel || requestedChannels[0]].filter(Boolean),
				enabled: Boolean(saved?.enabled),
				updatedAt: saved?.updatedAt || null,
			},
		});
	} catch (error) {
		const mapped = mapPushError(
			error,
			"Impossible d'activer les notifications push.",
		);
		return res.status(mapped.status).json({ message: mapped.message });
	}
};

exports.unsubscribe = async (req, res) => {
	try {
		if (!req.userId) {
			throw createUserError('Authentification requise.', 401);
		}

		const endpoint = String(req.body?.endpoint || '').trim();
		if (!endpoint) {
			throw createUserError("L'endpoint push est requis.", 400);
		}

		const channels = parseRequestedChannels(
			{
				channels: req.body?.channels,
				channel: req.body?.channel,
			},
			'user',
			{ useDefault: false },
		);

		const hasRequestedChannels =
			Array.isArray(req.body?.channels) ||
			(typeof req.body?.channel === 'string' && req.body.channel.trim());

		if (hasRequestedChannels) {
			const invalidChannel = channels.find(
				(channel) => !Object.values(CHANNELS).includes(channel),
			);
			if (invalidChannel) {
				throw createUserError('Canal push invalide.', 400);
			}
			if (!channels.length) {
				throw createUserError('Aucun canal push valide.', 400);
			}
		}

		if (hasRequestedChannels) {
			const result = await unsubscribeChannels({
				userId: req.userId,
				endpoint,
				channels,
			});

			return res.status(200).json({
				message: 'Canaux push mis a jour.',
				deleted: Number(result?.deletedCount || 0),
				modified: Number(result?.modifiedCount || 0),
				remainingChannels: Array.isArray(result?.remainingChannels) ?
						result.remainingChannels
					:	[],
			});
		}

		const result = await unsubscribe({
			userId: req.userId,
			endpoint,
		});

		return res.status(200).json({
			message: 'Abonnement push desactive.',
			deleted: Number(result?.deletedCount || 0),
		});
	} catch (error) {
		const mapped = mapPushError(
			error,
			"Impossible de desactiver l'abonnement push.",
		);
		return res.status(mapped.status).json({ message: mapped.message });
	}
};

exports.unsubscribeAll = async (req, res) => {
	try {
		if (!req.userId) {
			throw createUserError('Authentification requise.', 401);
		}

		const result = await unsubscribeAll({
			userId: req.userId,
		});

		return res.status(200).json({
			message: 'Tous les abonnements push ont ete desactives.',
			deleted: Number(result?.deletedCount || 0),
		});
	} catch (error) {
		const mapped = mapPushError(
			error,
			"Impossible de desactiver les abonnements push.",
		);
		return res.status(mapped.status).json({ message: mapped.message });
	}
};

exports.listSubscriptions = async (req, res) => {
	try {
		if (!req.userId) {
			throw createUserError('Authentification requise.', 401);
		}

		const items = await listUserSubscriptions(req.userId);
		return res.status(200).json({
			subscriptions: items.map((item) => {
				const channels =
					Array.isArray(item.channels) && item.channels.length ?
						item.channels
					:	[item.channel].filter(Boolean);

				return {
					id: item._id,
					endpoint: item.endpoint,
					channel: item.channel,
					channels,
					role: item.role,
					locale: item.locale || 'fr',
					platform: item.platform || null,
					deviceLabel: item.deviceLabel || null,
					lastSeenAt: item.lastSeenAt || null,
					updatedAt: item.updatedAt || null,
				};
			}),
		});
	} catch (error) {
		const mapped = mapPushError(
			error,
			'Impossible de recuperer les abonnements push.',
		);
		return res.status(mapped.status).json({ message: mapped.message });
	}
};
