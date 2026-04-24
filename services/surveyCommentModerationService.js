/** @format */

const {
	buildSurveyAlias,
	buildSurveyAliasMap,
	buildVoterKey,
} = require('../utils/commentAnonymizer');
const {
	CONTENT_MODERATION_VERDICTS,
} = require('../utils/contentModerationConfig');

const SURVEY_COMMENT_ERROR_CODES = Object.freeze({
	MODERATION_FORBIDDEN: 'SURVEY_COMMENT_MODERATION_FORBIDDEN',
	COMMENT_NOT_FOUND: 'SURVEY_COMMENT_NOT_FOUND',
	COMMENT_ALREADY_DELETED: 'SURVEY_COMMENT_ALREADY_DELETED',
	COMMENT_UNAVAILABLE: 'SURVEY_COMMENT_UNAVAILABLE',
	COMMENT_RESTORE_UNAVAILABLE: 'SURVEY_COMMENT_RESTORE_UNAVAILABLE',
});

const normalizeObjectIdString = (value) => (value ? String(value) : null);

const createSurveyCommentModerationError = (status, code, message) => {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
};

const isSurveyCommentModerationError = (error) =>
	Boolean(error?.status && typeof error?.message === 'string');

const isOpinionCommentDeleted = (opinion) => Boolean(opinion?.commentDeletedAt);
const isOpinionCommentAutoDeleted = (opinion) =>
	isOpinionCommentDeleted(opinion) && String(opinion?.commentDeletedSource || '') === 'auto';

const getOpinionVisibleReason = (opinion, { includeDeletedReason = false } = {}) => {
	if (isOpinionCommentDeleted(opinion) && !includeDeletedReason) return '';
	return typeof opinion?.reason === 'string' ? opinion.reason : '';
};

const hasOpinionVisibleComment = (opinion) =>
	String(getOpinionVisibleReason(opinion) || '').trim().length > 0;

const buildCommentModerationPayload = (opinion) => {
	const deleted = isOpinionCommentDeleted(opinion);
	return {
		isDeleted: deleted,
		deletedAt:
			deleted && opinion?.commentDeletedAt ?
				new Date(opinion.commentDeletedAt).toISOString()
			:	null,
		deletedSource: deleted ? String(opinion?.commentDeletedSource || 'manual') : null,
		moderationSource:
			deleted && opinion?.commentDeletedSource === 'auto' ?
				String(opinion?.commentModerationSource || 'fallback')
			:	null,
		reasonCodes:
			deleted && opinion?.commentDeletedSource === 'auto' ?
				Array.isArray(opinion?.commentModerationReasonCodes) ?
					[...new Set(opinion.commentModerationReasonCodes)]
				:	[]
			:	[],
		canRestore: Boolean(
			deleted && String(opinion?.commentDeletedSource || '') === 'auto',
		),
	};
};

const getOpinionExportPseudo = (opinion, surveyId, aliasMap = null) => {
	const userId = normalizeObjectIdString(opinion?.userId);
	if (userId && aliasMap instanceof Map && aliasMap.has(userId)) {
		return aliasMap.get(userId);
	}
	return buildSurveyAlias(surveyId, userId || 'guest');
};

const getOpinionDisplayPseudo = (opinion, surveyId, aliasMap = null) => {
	const rawPseudo = String(opinion?.userPseudo || '').trim();
	if (rawPseudo) return rawPseudo;
	return getOpinionExportPseudo(opinion, surveyId, aliasMap);
};

const toSafeOpinion = (opinion = {}) => ({
	_id: opinion?._id,
	answer: opinion?.answer,
	reason: getOpinionVisibleReason(opinion),
	createdAt: opinion?.createdAt,
	likeCount: Number(opinion?.likeCount || 0),
	dislikeCount: Number(opinion?.dislikeCount || 0),
	userLiked: Boolean(opinion?.userLiked),
	userDisliked: Boolean(opinion?.userDisliked),
	commentModeration: buildCommentModerationPayload(opinion),
	commentVisible: hasOpinionVisibleComment(opinion),
});

const prepareOpinionsForSurveyView = (
	opinions,
	surveyId,
	{
		includeAdminProfile = false,
		includeVoterKey = false,
		includeExportPseudo = false,
		adminProfilesByUserId = null,
		requesterUserId = null,
	} = {},
) => {
	const safeOpinions = Array.isArray(opinions) ? opinions : [];
	const aliasMap = buildSurveyAliasMap(
		surveyId,
		safeOpinions.map((opinion) => opinion?.userId),
	);
	const profileMap =
		adminProfilesByUserId instanceof Map ? adminProfilesByUserId : new Map();

	return safeOpinions.map((opinion) => {
		const userId = normalizeObjectIdString(opinion?.userId);
		const exportPseudo = getOpinionExportPseudo(opinion, surveyId, aliasMap);
		const isOwnOpinion =
			Boolean(requesterUserId) &&
			Boolean(userId) &&
			String(userId) === String(requesterUserId);

		const output = {
			...toSafeOpinion(opinion),
			userPseudo: getOpinionDisplayPseudo(opinion, surveyId, aliasMap),
			isOwnOpinion,
		};

		if (includeAdminProfile) {
			output.adminProfile = profileMap.get(userId) || {
				age: null,
				gender: 'non_renseigne',
			};
		}
		if (includeVoterKey) {
			output.voterKey = buildVoterKey(surveyId, userId || 'guest');
		}
		if (includeExportPseudo) {
			output.exportUserPseudo = exportPseudo;
		}

		return output;
	});
};

const prepareOpinionQueueItems = (
	items,
	surveyId,
	{ includeExportPseudo = false, includeModeratedReason = false } = {},
) => {
	const safeItems = Array.isArray(items) ? items : [];
	const aliasMap = buildSurveyAliasMap(
		surveyId,
		safeItems.map((item) => item?.userId),
	);

	return safeItems.map((item) => {
		const exportPseudo = getOpinionExportPseudo(item, surveyId, aliasMap);
		const output = {
			...item,
			reason: getOpinionVisibleReason(item, {
				includeDeletedReason: includeModeratedReason,
			}),
			userPseudo: getOpinionDisplayPseudo(item, surveyId, aliasMap),
			commentModeration: buildCommentModerationPayload(item),
			commentVisible: hasOpinionVisibleComment(item),
		};
		if (includeExportPseudo) {
			output.exportUserPseudo = exportPseudo;
		}
		return output;
	});
};

const validateOpinionCommentModerationTarget = ({
	survey,
	opinion,
	actorUserId,
	canModerate,
}) => {
	if (!actorUserId) {
		throw createSurveyCommentModerationError(
			403,
			SURVEY_COMMENT_ERROR_CODES.MODERATION_FORBIDDEN,
			'Authentification requise.',
		);
	}

	if (!canModerate) {
		throw createSurveyCommentModerationError(
			403,
			SURVEY_COMMENT_ERROR_CODES.MODERATION_FORBIDDEN,
			"Vous devez être owner ou admin de l'organisation pour modérer ce commentaire.",
		);
	}

	if (!survey?._id || !opinion?._id) {
		throw createSurveyCommentModerationError(
			404,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
			'Commentaire introuvable.',
		);
	}

	if (normalizeObjectIdString(opinion?.surveyId) !== normalizeObjectIdString(survey?._id)) {
		throw createSurveyCommentModerationError(
			404,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
			'Commentaire introuvable pour ce sondage.',
		);
	}

	if (isOpinionCommentDeleted(opinion)) {
		throw createSurveyCommentModerationError(
			409,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_ALREADY_DELETED,
			'Ce commentaire a déjà été supprimé.',
		);
	}

	if (!hasOpinionVisibleComment(opinion)) {
		throw createSurveyCommentModerationError(
			409,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE,
			'Ce vote ne contient pas de commentaire moderable.',
		);
	}
};

const assertOpinionCommentInteractable = (opinion) => {
	if (!opinion) {
		throw createSurveyCommentModerationError(
			404,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
			'Commentaire introuvable.',
		);
	}

	if (!hasOpinionVisibleComment(opinion)) {
		throw createSurveyCommentModerationError(
			410,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE,
			'Ce commentaire n est plus disponible.',
		);
	}
};

const applyOpinionCommentDeletion = async ({
	opinion,
	actorUserId,
	now = new Date(),
	source = 'manual',
	moderationLogId = null,
	moderationReasonCodes = [],
	moderationSource = null,
	moderationLocale = null,
}) => {
	assertOpinionCommentInteractable(opinion);
	opinion.commentDeletedAt = now;
	opinion.commentDeletedBy = source === 'manual' ? actorUserId : null;
	opinion.commentDeletedSource = source;
	opinion.commentModerationLogId = moderationLogId || null;
	opinion.commentModerationReasonCodes =
		source === 'auto' ? [...new Set(moderationReasonCodes)] : [];
	opinion.commentModerationSource = source === 'auto' ? moderationSource || 'fallback' : null;
	opinion.commentModerationLocale =
		source === 'auto' ? String(moderationLocale || '').trim() || null : null;
	await opinion.save();
	return {
		opinionId: normalizeObjectIdString(opinion?._id),
		surveyId: normalizeObjectIdString(opinion?.surveyId),
		deletedAt: new Date(now).toISOString(),
		deletedSource: source,
	};
};

const restoreOpinionComment = async ({
	opinion,
	actorUserId,
	now = new Date(),
}) => {
	if (!isOpinionCommentDeleted(opinion)) {
		throw createSurveyCommentModerationError(
			409,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_RESTORE_UNAVAILABLE,
			'Ce commentaire est déjà visible.',
		);
	}

	if (!isOpinionCommentAutoDeleted(opinion)) {
		throw createSurveyCommentModerationError(
			409,
			SURVEY_COMMENT_ERROR_CODES.COMMENT_RESTORE_UNAVAILABLE,
			'Seuls les commentaires auto-moderes peuvent etre restaures ici.',
		);
	}

	opinion.commentDeletedAt = null;
	opinion.commentDeletedBy = null;
	opinion.commentDeletedSource = null;
	opinion.commentModerationLogId = null;
	opinion.commentModerationReasonCodes = [];
	opinion.commentModerationSource = null;
	opinion.commentModerationLocale = null;
	await opinion.save();
	return {
		opinionId: normalizeObjectIdString(opinion?._id),
		surveyId: normalizeObjectIdString(opinion?.surveyId),
		restoredAt: new Date(now).toISOString(),
		restoredBy: normalizeObjectIdString(actorUserId),
	};
};

const buildAutoModerationCommentFields = ({
	decision,
	logEntry,
	now = new Date(),
}) => {
	if (
		decision?.appliedVerdict !== CONTENT_MODERATION_VERDICTS.AUTO_HIDE_COMMENT
	) {
		return {};
	}

	return {
		commentDeletedAt: now,
		commentDeletedBy: null,
		commentDeletedSource: 'auto',
		commentModerationLogId: logEntry?._id || null,
		commentModerationReasonCodes: Array.isArray(decision?.reasonCodes) ?
				[...new Set(decision.reasonCodes)]
			:	[],
		commentModerationSource: decision?.source || 'fallback',
		commentModerationLocale:
			String(decision?.locale || '').trim() || null,
	};
};

const buildCommentSubmissionModerationPayload = (opinion) => ({
	state:
		isOpinionCommentAutoDeleted(opinion) ?
			'auto_hidden'
		:	'visible',
	source: isOpinionCommentAutoDeleted(opinion) ? 'auto' : null,
});

module.exports = {
	SURVEY_COMMENT_ERROR_CODES,
	createSurveyCommentModerationError,
	isSurveyCommentModerationError,
	isOpinionCommentDeleted,
	isOpinionCommentAutoDeleted,
	hasOpinionVisibleComment,
	getOpinionVisibleReason,
	getOpinionDisplayPseudo,
	prepareOpinionsForSurveyView,
	prepareOpinionQueueItems,
	validateOpinionCommentModerationTarget,
	assertOpinionCommentInteractable,
	applyOpinionCommentDeletion,
	restoreOpinionComment,
	buildAutoModerationCommentFields,
	buildCommentSubmissionModerationPayload,
	__test__: {
		buildCommentModerationPayload,
		validateOpinionCommentModerationTarget,
	},
};
