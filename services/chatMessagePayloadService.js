/** @format */

const normalizeObjectId = (value) => {
	if (!value) return null;
	if (typeof value === 'string') return value;
	if (typeof value.toString === 'function') {
		const normalized = value.toString();
		return normalized && normalized !== '[object Object]' ? normalized : null;
	}
	return null;
};

const normalizeReplyToInfo = (replyToInfo) => {
	if (!replyToInfo) return null;

	const messageId =
		normalizeObjectId(replyToInfo.messageId) ||
		normalizeObjectId(replyToInfo._id) ||
		null;
	const userId = normalizeObjectId(replyToInfo.userId) || null;

	return {
		messageId,
		userId,
		pseudo: String(replyToInfo.pseudo || 'Utilisateur'),
		message: String(replyToInfo.message || ''),
	};
};

const buildAvatarFallbackUrl = (pseudo) =>
	'https://ui-avatars.com/api/?name=' +
	encodeURIComponent(String(pseudo || 'Utilisateur')) +
	'&background=6366f1&color=fff';

const toPlainMessageObject = (message) => {
	if (!message) return {};
	if (typeof message.toObject === 'function') {
		return message.toObject();
	}
	return { ...message };
};

const formatChatMessagePayload = (message, { actorUserId = null } = {}) => {
	const likes = Array.isArray(message?.likes) ? message.likes : [];
	const dislikes = Array.isArray(message?.dislikes) ? message.dislikes : [];
	const normalizedActorUserId = normalizeObjectId(actorUserId);
	const normalizedUserId = normalizeObjectId(message?.userId?._id || message?.userId);
	const pseudo = String(message?.userPseudo || message?.user?.pseudo || 'Utilisateur');
	const picture =
		message?.userId && typeof message.userId === 'object' && message.userId.picture ?
			message.userId.picture
		: message?.user?.picture || null;

	const payload = {
		...message,
		id: normalizeObjectId(message?.id) || normalizeObjectId(message?._id),
		likeCount: likes.length,
		dislikeCount: dislikes.length,
		userLiked:
			normalizedActorUserId ?
				likes.some((id) => normalizeObjectId(id) === normalizedActorUserId)
			:	false,
		userDisliked:
			normalizedActorUserId ?
				dislikes.some((id) => normalizeObjectId(id) === normalizedActorUserId)
			:	false,
		replyTo: normalizeObjectId(message?.replyTo),
		replyToInfo: normalizeReplyToInfo(message?.replyToInfo),
		user: {
			id: normalizedUserId,
			pseudo,
			picture: picture || buildAvatarFallbackUrl(pseudo),
		},
	};

	delete payload._id;
	delete payload.__v;

	return payload;
};

const buildFreshChatMessagePayload = (
	message,
	{ actorUserId = null, userId = null, pseudo = null, picture = null } = {},
) => {
	const baseMessage = toPlainMessageObject(message);
	const normalizedUserId =
		normalizeObjectId(userId) || normalizeObjectId(baseMessage.userId) || null;
	const resolvedPseudo = String(
		pseudo || baseMessage.userPseudo || baseMessage.user?.pseudo || 'Utilisateur',
	);
	const resolvedPicture = picture || baseMessage.user?.picture || null;

	return formatChatMessagePayload(
		{
			...baseMessage,
			userId: normalizedUserId || baseMessage.userId,
			userPseudo: resolvedPseudo,
			user: {
				id: normalizedUserId,
				pseudo: resolvedPseudo,
				picture: resolvedPicture,
			},
		},
		{ actorUserId },
	);
};

module.exports = {
	buildFreshChatMessagePayload,
	formatChatMessagePayload,
	normalizeObjectId,
	normalizeReplyToInfo,
};
