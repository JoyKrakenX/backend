/** @format */

const webPush = require('web-push');
const SupportPushSubscription = require('../models/SupportPushSubscription');
const User = require('../models/User');
const { getSupportAdminEmails } = require('../utils/supportAdminAllowlist');

const CHANNELS = Object.freeze({
	SUPPORT_QUEUE: 'support_queue',
	SUPPORT_REPLY: 'support_reply',
	SURVEY_NEW: 'survey_new',
	SURVEY_CLOSED: 'survey_closed',
});

const ALLOWED_CHANNELS = new Set(Object.values(CHANNELS));
const SUPPORT_ROLES = new Set(['support', 'admin']);

const QUEUE_DEDUP_WINDOW_MS = 15_000;
const CLIENT_REPLY_DEDUP_WINDOW_MS = 60_000;
const SURVEY_EVENT_DEDUP_WINDOW_MS = 20_000;
const pushDedupCache = new Map();

let vapidInitialized = false;
let lastInitErrorLoggedAt = 0;

const SURVEY_PUSH_TRANSLATIONS = Object.freeze({
	fr: {
		surveyNewTitle: 'Nouveau sondage en ligne',
		surveyNewBody: '{creator} a publie "{theme}".',
		surveyClosedTitle: 'Sondage cloture',
		surveyClosedBody:
			'Le sondage "{theme}" est cloture. Consultez les resultats.',
	},
	en: {
		surveyNewTitle: 'New survey available',
		surveyNewBody: '{creator} published "{theme}".',
		surveyClosedTitle: 'Survey closed',
		surveyClosedBody:
			'The survey "{theme}" has been closed. Check the results.',
	},
	es: {
		surveyNewTitle: 'Nueva encuesta disponible',
		surveyNewBody: '{creator} publico "{theme}".',
		surveyClosedTitle: 'Encuesta cerrada',
		surveyClosedBody:
			'La encuesta "{theme}" se ha cerrado. Consulta los resultados.',
	},
	de: {
		surveyNewTitle: 'Neue Umfrage verfugbar',
		surveyNewBody: '{creator} hat "{theme}" veroffentlicht.',
		surveyClosedTitle: 'Umfrage geschlossen',
		surveyClosedBody:
			'Die Umfrage "{theme}" wurde geschlossen. Sieh dir die Ergebnisse an.',
	},
});

const canSendPush = () =>
	String(process.env.PUSH_ENABLED || '').toLowerCase() === 'true' &&
	Boolean(
		process.env.VAPID_PUBLIC_KEY &&
			process.env.VAPID_PRIVATE_KEY &&
			process.env.VAPID_SUBJECT,
	);

const getDefaultChannelForRole = (role) =>
	role === 'support' || role === 'admin' ?
		CHANNELS.SUPPORT_QUEUE
	:	CHANNELS.SUPPORT_REPLY;

const isAllowedChannelForRole = (role, channel) => {
	const normalizedChannel = String(channel || '').trim();
	if (!ALLOWED_CHANNELS.has(normalizedChannel)) return false;

	if (normalizedChannel === CHANNELS.SUPPORT_QUEUE) {
		return role === 'support' || role === 'admin';
	}

	return true;
};

const normalizeLocale = (value) => {
	const locale = String(value || 'fr').trim().toLowerCase();
	return ['fr', 'en', 'es', 'de'].includes(locale) ? locale : 'fr';
};

const sanitizeString = (value, max = 300) => String(value || '').trim().slice(0, max);

const formatTemplate = (template, params = {}) =>
	String(template || '').replace(/\{(\w+)\}/g, (_full, key) =>
		String(params[key] ?? ''),
	);

const getSurveyStrings = (locale) =>
	SURVEY_PUSH_TRANSLATIONS[normalizeLocale(locale)] ||
	SURVEY_PUSH_TRANSLATIONS.fr;

const resolveSurveyUrl = ({
	surveyId,
	surveyType,
	closed = false,
	explain = true,
}) => {
	const normalizedId = String(surveyId || '').trim();
	if (!normalizedId) return '/browse-surveys.html';

	const normalizedType = String(surveyType || 'binary').toLowerCase();
	const isClassicSurvey = explain !== false;

	if (closed && !isClassicSurvey) {
		return normalizedType === 'multiple' ?
				`/survey-flash-multiple.html?id=${encodeURIComponent(normalizedId)}`
			:	`/survey-flash-binary.html?id=${encodeURIComponent(normalizedId)}`;
	}

	if (normalizedType === 'multiple') {
		return explain === false ?
				`/survey-flash-multiple.html?id=${encodeURIComponent(normalizedId)}`
			:	`/survey-choices.html?id=${encodeURIComponent(normalizedId)}`;
	}

	return explain === false ?
			`/survey-flash-binary.html?id=${encodeURIComponent(normalizedId)}`
		:	`/survey.html?id=${encodeURIComponent(normalizedId)}`;
};

const buildSurveyNewPayload = ({
	locale,
	surveyId,
	surveyType = 'binary',
	explain = true,
	theme,
	creatorName,
}) => {
	const strings = getSurveyStrings(locale);
	const safeTheme = String(theme || 'Sondage').trim() || 'Sondage';
	const safeCreator = String(creatorName || 'Administrateur').trim() || 'Administrateur';

	return JSON.stringify({
		type: 'survey.new',
		surveyId: String(surveyId || ''),
		surveyType: String(surveyType || 'binary'),
		theme: safeTheme,
		title: strings.surveyNewTitle,
		body: formatTemplate(strings.surveyNewBody, {
			theme: safeTheme,
			creator: safeCreator,
		}),
		url: resolveSurveyUrl({
			surveyId,
			surveyType,
			explain,
			closed: false,
		}),
		receivedAt: new Date().toISOString(),
	});
};

const buildSurveyClosedPayload = ({
	locale,
	surveyId,
	surveyType = 'binary',
	explain = true,
	theme,
}) => {
	const strings = getSurveyStrings(locale);
	const safeTheme = String(theme || 'Sondage').trim() || 'Sondage';

	return JSON.stringify({
		type: 'survey.closed',
		surveyId: String(surveyId || ''),
		surveyType: String(surveyType || 'binary'),
		theme: safeTheme,
		title: strings.surveyClosedTitle,
		body: formatTemplate(strings.surveyClosedBody, {
			theme: safeTheme,
		}),
		url: resolveSurveyUrl({
			surveyId,
			surveyType,
			explain,
			closed: true,
		}),
		receivedAt: new Date().toISOString(),
	});
};

const initVapid = () => {
	if (vapidInitialized) return true;
	if (!canSendPush()) return false;

	try {
		webPush.setVapidDetails(
			process.env.VAPID_SUBJECT,
			process.env.VAPID_PUBLIC_KEY,
			process.env.VAPID_PRIVATE_KEY,
		);
		vapidInitialized = true;
		return true;
	} catch (error) {
		const now = Date.now();
		if (now - lastInitErrorLoggedAt > 10_000) {
			lastInitErrorLoggedAt = now;
			console.error('[SupportPush] VAPID init failed:', error?.message || error);
		}
		return false;
	}
};

const ensurePushReady = () => {
	if (!initVapid()) {
		const error = new Error(
			'Push service unavailable: missing or invalid web push configuration.',
		);
		error.code = 'PUSH_NOT_CONFIGURED';
		error.status = 503;
		throw error;
	}
};

const isValidSubscriptionPayload = (subscription) => {
	if (!subscription || typeof subscription !== 'object') return false;
	if (!subscription.endpoint || typeof subscription.endpoint !== 'string') return false;
	if (!subscription.keys || typeof subscription.keys !== 'object') return false;
	if (!subscription.keys.p256dh || !subscription.keys.auth) return false;
	return true;
};

const normalizeRequestedChannels = ({
	channels,
	channel,
	role,
	useDefault = true,
}) => {
	const collected = [];

	if (Array.isArray(channels)) {
		collected.push(...channels);
	}

	if (typeof channel === 'string' && channel.trim()) {
		collected.push(channel);
	}

	const normalized = Array.from(
		new Set(
			collected
				.map((item) => sanitizeString(item, 40))
				.filter((item) => ALLOWED_CHANNELS.has(item))
				.filter((item) => isAllowedChannelForRole(role, item)),
		),
	);

	if (normalized.length || !useDefault) return normalized;

	const defaultChannel = getDefaultChannelForRole(role);
	return isAllowedChannelForRole(role, defaultChannel) ? [defaultChannel] : [];
};

const getRecordChannels = (record) => {
	if (!record || typeof record !== 'object') return [];

	const channels =
		Array.isArray(record.channels) && record.channels.length ?
			record.channels
		:	record.channel ? [record.channel]
		:	[];

	return Array.from(
		new Set(
			channels
				.map((item) => String(item || '').trim())
				.filter((item) => ALLOWED_CHANNELS.has(item)),
		),
	);
};

const cleanupDedupCache = () => {
	const now = Date.now();
	pushDedupCache.forEach((state, key) => {
		if (!state || now - state.timestamp > state.windowMs) {
			pushDedupCache.delete(key);
		}
	});
};

const shouldSendWithDedup = (dedupKey, windowMs) => {
	cleanupDedupCache();
	if (!dedupKey || !windowMs) return true;

	const previous = pushDedupCache.get(dedupKey);
	if (previous && Date.now() - previous.timestamp < previous.windowMs) {
		return false;
	}

	pushDedupCache.set(dedupKey, {
		timestamp: Date.now(),
		windowMs,
	});
	return true;
};

const normalizeSubscription = (record) => ({
	endpoint: record.endpoint,
	expirationTime: null,
	keys: {
		p256dh: record.keys?.p256dh,
		auth: record.keys?.auth,
	},
});

const removeInvalidSubscription = async (record) => {
	try {
		await SupportPushSubscription.deleteOne({ _id: record._id });
	} catch (_error) {
		/* silent cleanup */
	}
};

const sendOnePush = async ({ record, payload, topic }) => {
	try {
		await webPush.sendNotification(normalizeSubscription(record), payload, {
			TTL: 90,
			urgency: 'high',
			topic,
		});
		return { sent: 1, failed: 0 };
	} catch (error) {
		const statusCode = Number(error?.statusCode || 0);
		if (statusCode === 404 || statusCode === 410) {
			await removeInvalidSubscription(record);
		}
		return { sent: 0, failed: 1 };
	}
};

const sendNotificationBatch = async ({ subscriptions, payload, topic }) => {
	let sent = 0;
	let failed = 0;

	await Promise.all(
		subscriptions.map(async (record) => {
			const result = await sendOnePush({ record, payload, topic });
			sent += result.sent;
			failed += result.failed;
		}),
	);

	return { sent, failed, skipped: false };
};

const sendNotificationBatchByLocale = async ({
	subscriptions,
	buildPayloadForLocale,
	topicPrefix,
}) => {
	let sent = 0;
	let failed = 0;

	const payloadCache = new Map();
	const getPayload = (locale) => {
		const normalized = normalizeLocale(locale);
		if (!payloadCache.has(normalized)) {
			payloadCache.set(normalized, buildPayloadForLocale(normalized));
		}
		return payloadCache.get(normalized);
	};

	await Promise.all(
		subscriptions.map(async (record) => {
			const locale = normalizeLocale(record?.locale);
			const payload = getPayload(locale);
			const topic = `${topicPrefix}-${locale}`;
			const result = await sendOnePush({ record, payload, topic });
			sent += result.sent;
			failed += result.failed;
		}),
	);

	return { sent, failed, skipped: false };
};

const getPublicKey = () => {
	ensurePushReady();
	return process.env.VAPID_PUBLIC_KEY;
};

const upsertSubscription = async ({
	userId,
	role,
	channel,
	channels,
	subscription,
	userAgent,
	platform,
	deviceLabel,
	locale,
}) => {
	ensurePushReady();
	if (!isValidSubscriptionPayload(subscription)) {
		const error = new Error('Invalid push subscription payload.');
		error.code = 'INVALID_PUSH_SUBSCRIPTION';
		error.status = 400;
		throw error;
	}

	const normalizedRole = SUPPORT_ROLES.has(role) ? role : 'user';
	const requestedChannels = normalizeRequestedChannels({
		channels,
		channel,
		role: normalizedRole,
		useDefault: true,
	});

	if (!requestedChannels.length) {
		const error = new Error('Invalid push channel for current role.');
		error.code = 'INVALID_PUSH_CHANNEL';
		error.status = 400;
		throw error;
	}

	const endpoint = sanitizeString(subscription.endpoint, 2000);
	const existing = await SupportPushSubscription.findOne({ endpoint }).lean();
	const existingChannels = getRecordChannels(existing).filter((item) =>
		isAllowedChannelForRole(normalizedRole, item),
	);
	const mergedChannels = Array.from(
		new Set([...existingChannels, ...requestedChannels]),
	);

	const data = {
		userId,
		role: normalizedRole,
		channel: mergedChannels[0] || requestedChannels[0],
		channels: mergedChannels.length ? mergedChannels : requestedChannels,
		locale: normalizeLocale(locale),
		endpoint,
		keys: {
			p256dh: sanitizeString(subscription.keys.p256dh, 2000),
			auth: sanitizeString(subscription.keys.auth, 2000),
		},
		userAgent: sanitizeString(userAgent, 500) || null,
		platform: sanitizeString(platform, 80) || null,
		deviceLabel: sanitizeString(deviceLabel, 120) || null,
		enabled: true,
		lastSeenAt: new Date(),
	};

	return SupportPushSubscription.findOneAndUpdate(
		{ endpoint },
		{ $set: data },
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	).lean();
};

const unsubscribe = async ({ userId, endpoint }) => {
	const normalizedEndpoint = sanitizeString(endpoint, 2000);
	if (!normalizedEndpoint) return { deletedCount: 0 };
	return SupportPushSubscription.deleteOne({
		userId,
		endpoint: normalizedEndpoint,
	});
};

const unsubscribeChannels = async ({ userId, endpoint, channels }) => {
	const normalizedEndpoint = sanitizeString(endpoint, 2000);
	if (!normalizedEndpoint) return { deletedCount: 0, modifiedCount: 0 };

	const channelsToRemove = normalizeRequestedChannels({
		channels,
		role: 'admin',
		useDefault: false,
	});

	if (!channelsToRemove.length) {
		return unsubscribe({ userId, endpoint: normalizedEndpoint });
	}

	const existing = await SupportPushSubscription.findOne({
		userId,
		endpoint: normalizedEndpoint,
	}).lean();

	if (!existing) {
		return { deletedCount: 0, modifiedCount: 0, remainingChannels: [] };
	}

	const remainingChannels = getRecordChannels(existing).filter(
		(item) => !channelsToRemove.includes(item),
	);

	if (!remainingChannels.length) {
		const removed = await SupportPushSubscription.deleteOne({
			userId,
			endpoint: normalizedEndpoint,
		});
		return {
			deletedCount: Number(removed?.deletedCount || 0),
			modifiedCount: 0,
			remainingChannels: [],
		};
	}

	await SupportPushSubscription.updateOne(
		{ userId, endpoint: normalizedEndpoint },
		{
			$set: {
				channels: remainingChannels,
				channel: remainingChannels[0],
				lastSeenAt: new Date(),
			},
		},
	);

	return {
		deletedCount: 0,
		modifiedCount: 1,
		remainingChannels,
	};
};

const unsubscribeAll = async ({ userId }) =>
	SupportPushSubscription.deleteMany({
		userId,
	});

const listUserSubscriptions = async (userId) =>
	SupportPushSubscription.find({ userId, enabled: true })
		.sort({ updatedAt: -1 })
		.lean();

const buildChannelQuery = (channel) => ({
	$or: [{ channels: channel }, { channel }],
});

const buildQueuePayload = ({
	reason,
	conversationId,
	conversationRef,
	status = 'waiting',
	category = 'general',
	lastMessageAt,
}) =>
	JSON.stringify({
		type: 'support.queue',
		reason: String(reason || 'new_conversation'),
		conversationId: String(conversationId || ''),
		conversationRef: String(conversationRef || ''),
		status: String(status || 'waiting'),
		category: String(category || 'general'),
		title:
			reason === 'new_client_message' ?
				'Nouveau message client'
			:	'Nouveau contact support',
		body:
			reason === 'new_client_message' ?
				'Un client attend une reponse dans la file support.'
			:	'Une nouvelle conversation est entree dans la file support.',
		url: `/support-chat-admin.html?conversationId=${encodeURIComponent(
			String(conversationId || ''),
		)}`,
		lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
		receivedAt: new Date().toISOString(),
	});

const buildClientReplyPayload = ({
	reason,
	conversationId,
	conversationRef,
	status = 'assigned',
	lastMessageAt,
}) =>
	JSON.stringify({
		type: 'support.reply',
		reason: String(reason || 'agent_reply'),
		conversationId: String(conversationId || ''),
		conversationRef: String(conversationRef || ''),
		status: String(status || 'assigned'),
		title: 'Nouvelle reponse du support',
		body: 'Un agent a repondu a votre message.',
		url: `/support-chat.html?conversationId=${encodeURIComponent(
			String(conversationId || ''),
		)}`,
		lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
		receivedAt: new Date().toISOString(),
	});

const broadcastQueuePush = async ({
	reason,
	conversationId,
	conversationRef,
	status,
	category,
	lastMessageAt,
}) => {
	if (!canSendPush()) return { sent: 0, failed: 0, skipped: true };

	const dedupKey = `queue:${String(conversationId || '')}:${String(reason || '')}`;
	if (!shouldSendWithDedup(dedupKey, QUEUE_DEDUP_WINDOW_MS)) {
		return { sent: 0, failed: 0, skipped: true, dedup: true };
	}

	ensurePushReady();

	const allowlistedEmails = getSupportAdminEmails();
	if (!allowlistedEmails.length) {
		return { sent: 0, failed: 0, skipped: true };
	}

	const allowlistedUsers = await User.find({
		email: { $in: allowlistedEmails },
	})
		.select('_id')
		.lean();
	const allowlistedUserIds = allowlistedUsers.map((item) => item._id);
	if (!allowlistedUserIds.length) {
		return { sent: 0, failed: 0, skipped: true };
	}

	const subscriptions = await SupportPushSubscription.find({
		$and: [
			{ userId: { $in: allowlistedUserIds } },
			{ role: { $in: ['support', 'admin'] } },
			buildChannelQuery(CHANNELS.SUPPORT_QUEUE),
			{ enabled: true },
		],
	}).lean();
	if (!subscriptions.length) return { sent: 0, failed: 0, skipped: true };

	const payload = buildQueuePayload({
		reason,
		conversationId,
		conversationRef,
		status,
		category,
		lastMessageAt,
	});

	return sendNotificationBatch({
		subscriptions,
		payload,
		topic: `support-queue-${String(conversationId || 'all')}`,
	});
};

const broadcastClientReplyPush = async ({
	clientUserId,
	conversationId,
	conversationRef,
	status,
	reason = 'agent_reply',
	lastMessageAt,
}) => {
	if (!canSendPush()) return { sent: 0, failed: 0, skipped: true };
	if (!clientUserId) return { sent: 0, failed: 0, skipped: true };

	const dedupKey = `client:${String(clientUserId)}:${String(conversationId || '')}:${String(
		reason || 'agent_reply',
	)}`;
	if (!shouldSendWithDedup(dedupKey, CLIENT_REPLY_DEDUP_WINDOW_MS)) {
		return { sent: 0, failed: 0, skipped: true, dedup: true };
	}

	ensurePushReady();

	const subscriptions = await SupportPushSubscription.find({
		$and: [
			{ userId: clientUserId },
			buildChannelQuery(CHANNELS.SUPPORT_REPLY),
			{ enabled: true },
		],
	}).lean();
	if (!subscriptions.length) return { sent: 0, failed: 0, skipped: true };

	const payload = buildClientReplyPayload({
		reason,
		conversationId,
		conversationRef,
		status,
		lastMessageAt,
	});

	return sendNotificationBatch({
		subscriptions,
		payload,
		topic: `support-reply-${String(conversationId || 'conversation')}`,
	});
};

const broadcastSurveyNewPush = async ({
	surveyId,
	surveyType = 'binary',
	explain = true,
	theme,
	creatorName,
	excludeUserId,
}) => {
	if (!canSendPush()) return { sent: 0, failed: 0, skipped: true };

	const dedupKey = `survey:new:${String(surveyType || 'binary')}:${String(surveyId || '')}`;
	if (!shouldSendWithDedup(dedupKey, SURVEY_EVENT_DEDUP_WINDOW_MS)) {
		return { sent: 0, failed: 0, skipped: true, dedup: true };
	}

	ensurePushReady();

	const filters = [
		buildChannelQuery(CHANNELS.SURVEY_NEW),
		{ enabled: true },
	];
	if (excludeUserId) {
		filters.push({ userId: { $ne: excludeUserId } });
	}

	const subscriptions = await SupportPushSubscription.find({
		$and: filters,
	}).lean();

	if (!subscriptions.length) return { sent: 0, failed: 0, skipped: true };

	return sendNotificationBatchByLocale({
		subscriptions,
		topicPrefix: `survey-new-${String(surveyId || 'latest')}`,
		buildPayloadForLocale: (locale) =>
			buildSurveyNewPayload({
				locale,
				surveyId,
				surveyType,
				explain,
				theme,
				creatorName,
			}),
	});
};

const broadcastSurveyClosedPush = async ({
	surveyId,
	surveyType = 'binary',
	explain = true,
	theme,
	participantUserIds = [],
}) => {
	if (!canSendPush()) return { sent: 0, failed: 0, skipped: true };

	const uniqueParticipantIds = Array.from(
		new Set(
			(Array.isArray(participantUserIds) ? participantUserIds : [])
				.map((item) => String(item || '').trim())
				.filter(Boolean),
		),
	);

	if (!uniqueParticipantIds.length) {
		return { sent: 0, failed: 0, skipped: true };
	}

	const dedupKey = `survey:closed:${String(surveyType || 'binary')}:${String(surveyId || '')}`;
	if (!shouldSendWithDedup(dedupKey, SURVEY_EVENT_DEDUP_WINDOW_MS)) {
		return { sent: 0, failed: 0, skipped: true, dedup: true };
	}

	ensurePushReady();

	const subscriptions = await SupportPushSubscription.find({
		$and: [
			{ userId: { $in: uniqueParticipantIds } },
			buildChannelQuery(CHANNELS.SURVEY_CLOSED),
			{ enabled: true },
		],
	}).lean();

	if (!subscriptions.length) return { sent: 0, failed: 0, skipped: true };

	return sendNotificationBatchByLocale({
		subscriptions,
		topicPrefix: `survey-closed-${String(surveyId || 'latest')}`,
		buildPayloadForLocale: (locale) =>
			buildSurveyClosedPayload({
				locale,
				surveyId,
				surveyType,
				explain,
				theme,
			}),
	});
};

console.log(`[SupportPush] ready=${canSendPush() ? 'true' : 'false'}`);

module.exports = {
	CHANNELS,
	canSendPush,
	getPublicKey,
	upsertSubscription,
	unsubscribe,
	unsubscribeChannels,
	unsubscribeAll,
	listUserSubscriptions,
	broadcastQueuePush,
	broadcastClientReplyPush,
	broadcastSurveyNewPush,
	broadcastSurveyClosedPush,
	getDefaultChannelForRole,
	isAllowedChannelForRole,
	normalizeLocale,
};
