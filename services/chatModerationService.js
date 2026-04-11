/** @format */

const mongoose = require('mongoose');

const ChatMessage = require('../models/ChatMessage');
const ChatModerationState = require('../models/ChatModerationState');
const OrganizationMember = require('../models/OrganizationMember');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const {
	canManageSurveyByOrganization,
} = require('./surveyAuthorizationService');
const { resolveSurveyOrganizationId } = require('./surveyOrganizationService');

const CHAT_RESTRICTION_STATES = Object.freeze({
	NONE: 'none',
	MUTED: 'muted',
	BANNED: 'banned',
});

const CHAT_ERROR_CODES = Object.freeze({
	MUTED: 'CHAT_MUTED',
	BANNED: 'CHAT_BANNED',
	MODERATION_FORBIDDEN: 'CHAT_MODERATION_FORBIDDEN',
	TARGET_PROTECTED: 'CHAT_TARGET_PROTECTED',
	AUTO_MODERATED: 'CHAT_AUTO_MODERATED',
	AUTO_MODERATION_UNAVAILABLE: 'CHAT_AUTO_MODERATION_UNAVAILABLE',
});

const MUTE_DURATION_MS = 10 * 60 * 1000;

const resolveSurveyModelFromName = (surveyModelName) =>
	surveyModelName === 'Survey_2' ? Survey_2 : Survey;

const buildSurveyUserRoomName = (surveyId, userId) =>
	`survey-${String(surveyId)}:user-${String(userId)}`;

const buildSurveyModeratorsRoomName = (surveyId) =>
	`survey-${String(surveyId)}:moderators`;

const createChatModerationError = (status, code, message) => {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
};

const isChatModerationError = (error) =>
	Boolean(error?.status && typeof error?.message === 'string');

const normalizeObjectIdString = (value) =>
	value ? String(value) : null;

const getRestrictionState = (restriction, now = new Date()) => {
	if (!restriction) return CHAT_RESTRICTION_STATES.NONE;
	if (restriction.bannedAt) return CHAT_RESTRICTION_STATES.BANNED;
	if (restriction.muteUntil && new Date(restriction.muteUntil) > now) {
		return CHAT_RESTRICTION_STATES.MUTED;
	}
	return CHAT_RESTRICTION_STATES.NONE;
};

const buildRestrictionPayload = (restriction, now = new Date()) => {
	const state = getRestrictionState(restriction, now);
	return {
		state,
		muteUntil:
			state === CHAT_RESTRICTION_STATES.MUTED && restriction?.muteUntil ?
				new Date(restriction.muteUntil).toISOString()
			:	null,
	};
};

const getViewerRestriction = async ({
	surveyId,
	surveyModel,
	userId,
	now = new Date(),
}) => {
	if (!surveyId || !surveyModel || !userId) {
		return buildRestrictionPayload(null, now);
	}

	const restriction = await ChatModerationState.findOne({
		surveyId,
		surveyModel,
		userId,
	})
		.select('muteUntil bannedAt')
		.lean();

	return buildRestrictionPayload(restriction, now);
};

const getRestrictionsMapForUsers = async ({
	surveyId,
	surveyModel,
	userIds = [],
	now = new Date(),
}) => {
	const normalizedUserIds = Array.from(
		new Set(
			userIds
				.filter(Boolean)
				.map((userId) => normalizeObjectIdString(userId)),
		),
	);
	if (!normalizedUserIds.length) return new Map();

	const objectIds = normalizedUserIds
		.filter((userId) => mongoose.Types.ObjectId.isValid(userId))
		.map((userId) => new mongoose.Types.ObjectId(userId));
	if (!objectIds.length) return new Map();

	const restrictions = await ChatModerationState.find({
		surveyId,
		surveyModel,
		userId: { $in: objectIds },
	})
		.select('userId muteUntil bannedAt')
		.lean();

	const restrictionMap = new Map();
	for (const restriction of restrictions) {
		restrictionMap.set(
			normalizeObjectIdString(restriction.userId),
			buildRestrictionPayload(restriction, now),
		);
	}

	return restrictionMap;
};

const getProtectedTargetUserIds = async ({ survey, organizationId }) => {
	const protectedIds = new Set();
	if (survey?.userId) {
		protectedIds.add(normalizeObjectIdString(survey.userId));
	}

	if (!organizationId) return protectedIds;

	const protectedMembers = await OrganizationMember.find({
		organizationId,
		role: { $in: ['owner', 'admin'] },
	})
		.select('userId')
		.lean();

	for (const member of protectedMembers) {
		if (member?.userId) {
			protectedIds.add(normalizeObjectIdString(member.userId));
		}
	}

	return protectedIds;
};

const validateModerationTarget = ({
	chatMessage,
	survey,
	protectedTargetUserIds = new Set(),
	actorUserId,
	canModerate,
	requireOpenSurvey = false,
}) => {
	if (!actorUserId) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Authentification requise.',
		);
	}

	if (!canModerate) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Vous devez etre owner ou admin de cette organisation pour moderer le chat.',
		);
	}

	if (chatMessage?.isSystemMessage) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Les messages systeme ne peuvent pas etre moderes.',
		);
	}

	if (requireOpenSurvey && survey?.isClosed) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Le chat est archive. Vous ne pouvez plus appliquer de sanction active.',
		);
	}

	if (
		normalizeObjectIdString(chatMessage?.userId) ===
		normalizeObjectIdString(actorUserId)
	) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Vous ne pouvez pas vous moderer vous-meme.',
		);
	}

	if (
		protectedTargetUserIds.has(normalizeObjectIdString(chatMessage?.userId))
	) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.TARGET_PROTECTED,
			'Cette cible est protegee et ne peut pas etre mutee ni bannie.',
		);
	}
};

const assertViewerCanInteract = async ({
	surveyId,
	surveyModel,
	userId,
	now = new Date(),
}) => {
	const restriction = await getViewerRestriction({
		surveyId,
		surveyModel,
		userId,
		now,
	});

	if (restriction.state === CHAT_RESTRICTION_STATES.BANNED) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.BANNED,
			'Vous ne pouvez plus participer a ce chat.',
		);
	}

	if (restriction.state === CHAT_RESTRICTION_STATES.MUTED) {
		throw createChatModerationError(
			403,
			CHAT_ERROR_CODES.MUTED,
			'Vous avez ete mis en sourdine sur ce chat pendant 10 minutes.',
		);
	}

	return restriction;
};

const resolveMessageModerationContext = async (messageId) => {
	if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
		throw createChatModerationError(
			400,
			CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
			'messageId manquant ou invalide',
		);
	}

	const chatMessage = await ChatMessage.findById(messageId)
		.select(
			'_id surveyId surveyModel isSystemMessage userId userPseudo createdAt replyTo replyToInfo',
		)
		.lean();

	if (!chatMessage) {
		throw createChatModerationError(404, 'CHAT_MESSAGE_NOT_FOUND', 'Message introuvable');
	}

	const surveyModel = resolveSurveyModelFromName(chatMessage.surveyModel);
	const survey = await surveyModel
		.findById(chatMessage.surveyId)
		.select('theme question isClosed organizationId userId')
		.lean();

	if (!survey) {
		throw createChatModerationError(404, 'CHAT_SURVEY_NOT_FOUND', 'Sondage introuvable');
	}

	const organizationId = await resolveSurveyOrganizationId(survey);
	const protectedTargetUserIds = await getProtectedTargetUserIds({
		survey,
		organizationId,
	});

	return {
		chatMessage,
		survey,
		organizationId,
		protectedTargetUserIds,
	};
};

const assertActorCanModerateMessage = async ({
	context,
	actorUserId,
	requireOpenSurvey = false,
}) => {
	const { chatMessage, survey, protectedTargetUserIds } = context;

	const canModerate = await canManageSurveyByOrganization(survey, actorUserId);
	validateModerationTarget({
		chatMessage,
		survey,
		protectedTargetUserIds,
		actorUserId,
		canModerate,
		requireOpenSurvey,
	});
};

const applyMuteFromMessage = async ({
	messageId,
	actorUserId,
	now = new Date(),
}) => {
	const context = await resolveMessageModerationContext(messageId);
	await assertActorCanModerateMessage({
		context,
		actorUserId,
		requireOpenSurvey: true,
	});

	const { chatMessage, organizationId } = context;
	const existing = await ChatModerationState.findOne({
		surveyId: chatMessage.surveyId,
		surveyModel: chatMessage.surveyModel,
		userId: chatMessage.userId,
	})
		.select('_id muteUntil bannedAt')
		.lean();

	if (existing?.bannedAt) {
		return {
			context,
			restriction: buildRestrictionPayload(existing, now),
			targetUserId: normalizeObjectIdString(chatMessage.userId),
			targetUserPseudo: chatMessage.userPseudo || 'Utilisateur',
		};
	}

	const muteUntil = new Date(now.getTime() + MUTE_DURATION_MS);
	await ChatModerationState.findOneAndUpdate(
		{
			surveyId: chatMessage.surveyId,
			surveyModel: chatMessage.surveyModel,
			userId: chatMessage.userId,
		},
		{
			$set: {
				organizationId,
				userPseudoSnapshot: chatMessage.userPseudo || 'Utilisateur',
				muteUntil,
				bannedAt: null,
				lastActionByUserId: actorUserId,
				lastSourceMessageId: chatMessage._id,
			},
		},
		{
			new: true,
			upsert: true,
			setDefaultsOnInsert: true,
		},
	);

	return {
		context,
		restriction: {
			state: CHAT_RESTRICTION_STATES.MUTED,
			muteUntil: muteUntil.toISOString(),
		},
		targetUserId: normalizeObjectIdString(chatMessage.userId),
		targetUserPseudo: chatMessage.userPseudo || 'Utilisateur',
	};
};

const applyBanFromMessage = async ({
	messageId,
	actorUserId,
	now = new Date(),
}) => {
	const context = await resolveMessageModerationContext(messageId);
	await assertActorCanModerateMessage({
		context,
		actorUserId,
		requireOpenSurvey: true,
	});

	const { chatMessage, organizationId } = context;
	const bannedAt = now;

	await ChatModerationState.findOneAndUpdate(
		{
			surveyId: chatMessage.surveyId,
			surveyModel: chatMessage.surveyModel,
			userId: chatMessage.userId,
		},
		{
			$set: {
				organizationId,
				userPseudoSnapshot: chatMessage.userPseudo || 'Utilisateur',
				bannedAt,
				lastActionByUserId: actorUserId,
				lastSourceMessageId: chatMessage._id,
			},
			$unset: {
				muteUntil: 1,
			},
		},
		{
			new: true,
			upsert: true,
			setDefaultsOnInsert: true,
		},
	);

	return {
		context,
		restriction: {
			state: CHAT_RESTRICTION_STATES.BANNED,
			muteUntil: null,
		},
		targetUserId: normalizeObjectIdString(chatMessage.userId),
		targetUserPseudo: chatMessage.userPseudo || 'Utilisateur',
	};
};

module.exports = {
	MUTE_DURATION_MS,
	CHAT_RESTRICTION_STATES,
	CHAT_ERROR_CODES,
	buildSurveyModeratorsRoomName,
	buildSurveyUserRoomName,
	buildRestrictionPayload,
	createChatModerationError,
	getProtectedTargetUserIds,
	getRestrictionsMapForUsers,
	getViewerRestriction,
	isChatModerationError,
	resolveMessageModerationContext,
	assertViewerCanInteract,
	applyMuteFromMessage,
	applyBanFromMessage,
	__test__: {
		validateModerationTarget,
	},
};
