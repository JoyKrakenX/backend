/** @format */

const mongoose = require('mongoose');

const ChatMessage = require('../models/ChatMessage');
const Opinion = require('../models/Opinion');
const Opinion2 = require('../models/Opinion_2');
const OpinionFlash = require('../models/Opinion_Flash');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const Survey = require('../models/Survey');
const Survey2 = require('../models/Survey_2');
const BroadcastCue = require('../models/BroadcastCue');
const { resolveSurveyOrganizationId } = require('./surveyOrganizationService');
const { canManageSurveyByOrganization } = require('./surveyAuthorizationService');
const { buildSurveyOptionPayload } = require('../utils/multipleSurveyOptions');
const { normalizeSurveyStatus } = require('../utils/surveyStatus');
const { buildStatusFilter } = require('./fraud/opinionFilterService');
const {
	getOpinionDisplayPseudo,
	getOpinionVisibleReason,
} = require('./surveyCommentModerationService');

const MAX_SOURCE_RESULTS = 180;
const CHAT_SURVEY_MODEL_TO_TYPE = Object.freeze({
	Survey: 'binary',
	Survey_2: 'multiple',
});

const ensureObjectId = (value) => {
	const normalized = String(value || '').trim();
	if (!mongoose.Types.ObjectId.isValid(normalized)) {
		throw new Error('Invalid survey id');
	}
	return mongoose.Types.ObjectId.createFromHexString(normalized);
};

const normalizeMode = (survey) => (survey?.explain === false ? 'flash' : 'classic');
const normalizeSurveyKind = ({ surveyModel, survey }) => {
	const baseType = surveyModel === 'Survey_2' ? 'multiple' : 'binary';
	return `${baseType}_${normalizeMode(survey)}`;
};

const getOpinionModelBySurveyKind = (surveyKind) => {
	switch (surveyKind) {
		case 'binary_classic':
			return { model: Opinion, name: 'Opinion' };
		case 'binary_flash':
			return { model: OpinionFlash, name: 'Opinion_Flash' };
		case 'multiple_classic':
			return { model: Opinion2, name: 'Opinion_2' };
		case 'multiple_flash':
			return { model: Opinion2Flash, name: 'Opinion_2_Flash' };
		default:
			throw new Error(`Unsupported survey kind: ${surveyKind}`);
	}
};

const getResultRoomName = ({ surveyId, surveyKind }) => {
	switch (surveyKind) {
		case 'binary_classic':
			return `classic-binary-${String(surveyId)}`;
		case 'binary_flash':
			return `flash-binary-${String(surveyId)}`;
		case 'multiple_classic':
			return `classic-multiple-${String(surveyId)}`;
		case 'multiple_flash':
			return `flash-multiple-${String(surveyId)}`;
		default:
			return `broadcast-${String(surveyId)}`;
	}
};

const computeEngagementScore = ({ likes = 0, dislikes = 0 } = {}) =>
	Math.max(0, Number(likes || 0) * 4 - Number(dislikes || 0));

const toIsoString = (value) => {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const normalizeAnswerSnapshot = (candidate) => {
	if (!candidate) return '';
	if (typeof candidate.answer === 'boolean') return candidate.answer ? 'yes' : 'no';
	if (typeof candidate.answer === 'string') return candidate.answer;
	return '';
};

const serializeCue = (cue) => ({
	id: String(cue?._id || ''),
	sourceType: String(cue?.sourceType || ''),
	sourceId: String(cue?.sourceId || ''),
	sourceModel: String(cue?.sourceModel || ''),
	surveyId: String(cue?.surveyId || ''),
	surveyType: String(cue?.surveyType || ''),
	pseudoSnapshot: String(cue?.pseudoSnapshot || ''),
	textSnapshot: String(cue?.textSnapshot || ''),
	answerSnapshot: String(cue?.answerSnapshot || ''),
	sourceCreatedAt: toIsoString(cue?.sourceCreatedAt),
	engagement: {
		likes: Number(cue?.engagementSnapshot?.likes || 0),
		dislikes: Number(cue?.engagementSnapshot?.dislikes || 0),
		score: Number(cue?.engagementSnapshot?.score || 0),
	},
	visibilityState: String(cue?.visibilityState || 'visible'),
	airState: String(cue?.airState || 'approved'),
	featured: String(cue?.airState || '') === 'featured',
	airOrder: Number(cue?.airOrder || 0),
	broadcastScore: Number(cue?.broadcastScore || 0),
	approvedAt: toIsoString(cue?.approvedAt),
	featuredAt: toIsoString(cue?.featuredAt),
	updatedAt: toIsoString(cue?.updatedAt),
});

const scoreCandidate = ({ candidate, authorCounts, seenTexts, now = Date.now() }) => {
	const text = String(candidate?.textSnapshot || '').trim();
	const normalizedText = text.toLowerCase();
	const ageMinutes = Math.max(
		0,
		(now - new Date(candidate?.createdAt || Date.now()).getTime()) / 60000,
	);
	const recency = Math.max(0, 55 - Math.min(ageMinutes, 110) * 0.75);
	const engagement = computeEngagementScore(candidate.engagement) * 1.6;
	const length = text.length;
	const lengthDelta = Math.abs(110 - length);
	const lengthScore = Math.max(0, 24 - Math.min(lengthDelta / 4, 24));
	const authorKey = String(candidate?.pseudoSnapshot || '').trim().toLowerCase();
	const authorPenalty = Math.max(0, Number(authorCounts.get(authorKey) || 0) - 1) * 8;
	const duplicatePenalty = seenTexts.has(normalizedText) ? 22 : 0;
	const sourceBonus = candidate?.sourceType === 'survey_comment' ? 4 : 0;
	const finalScore = Math.round(recency + engagement + lengthScore + sourceBonus - authorPenalty - duplicatePenalty);
	seenTexts.add(normalizedText);
	authorCounts.set(authorKey, Number(authorCounts.get(authorKey) || 0) + 1);
	return finalScore;
};

const buildChatCandidate = (messageDoc, surveyContext) => {
	const text = String(messageDoc?.message || '').trim();
	if (!text) return null;
	if (messageDoc?.isSystemMessage) return null;
	const likes = Array.isArray(messageDoc?.likes) ? messageDoc.likes.length : 0;
	const dislikes = Array.isArray(messageDoc?.dislikes) ? messageDoc.dislikes.length : 0;
	return {
		sourceType: 'chat_message',
		sourceId: String(messageDoc._id),
		sourceModel: 'ChatMessage',
		surveyId: String(surveyContext.survey._id),
		surveyType: surveyContext.surveyKind,
		surveyModel: surveyContext.surveyModel,
		pseudoSnapshot: String(messageDoc.userPseudo || 'Participant'),
		textSnapshot: text,
		answerSnapshot: '',
		createdAt: messageDoc.createdAt || new Date(),
		engagement: {
			likes,
			dislikes,
			score: computeEngagementScore({ likes, dislikes }),
		},
		visibilityState: 'visible',
	};
};

const buildSurveyCommentCandidate = (opinionDoc, surveyContext) => {
	const text = String(getOpinionVisibleReason(opinionDoc) || '').trim();
	if (!text) return null;
	if (opinionDoc?.commentDeletedAt) return null;
	if (['quarantined', 'confirmed_fraud'].includes(String(opinionDoc?.fraudStatus || ''))) {
		return null;
	}
	const likes = Array.isArray(opinionDoc?.likes) ? opinionDoc.likes.length : 0;
	const dislikes = Array.isArray(opinionDoc?.dislikes) ? opinionDoc.dislikes.length : 0;
	return {
		sourceType: 'survey_comment',
		sourceId: String(opinionDoc._id),
		sourceModel: surveyContext.opinionModelName,
		surveyId: String(surveyContext.survey._id),
		surveyType: surveyContext.surveyKind,
		surveyModel: surveyContext.surveyModel,
		pseudoSnapshot: String(
			getOpinionDisplayPseudo(opinionDoc, surveyContext.survey._id) || opinionDoc?.userPseudo || 'Participant',
		),
		textSnapshot: text,
		answerSnapshot: normalizeAnswerSnapshot(opinionDoc),
		createdAt: opinionDoc.createdAt || new Date(),
		engagement: {
			likes,
			dislikes,
			score: computeEngagementScore({ likes, dislikes }),
		},
		visibilityState: 'visible',
	};
};

const sortCandidates = (candidates, sort = 'recommended') => {
	const items = [...candidates];
	if (sort === 'recent') {
		return items.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
	}
	if (sort === 'engagement') {
		return items.sort((left, right) => {
			const scoreDelta = Number(right.engagement?.score || 0) - Number(left.engagement?.score || 0);
			if (scoreDelta !== 0) return scoreDelta;
			return new Date(right.createdAt) - new Date(left.createdAt);
		});
	}
	if (sort === 'air') {
		return items.sort((left, right) => {
			const featureDelta = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
			if (featureDelta !== 0) return featureDelta;
			const stateDelta = String(right.broadcastState || '').localeCompare(String(left.broadcastState || ''));
			if (stateDelta !== 0) return stateDelta;
			return Number(right.broadcastScore || 0) - Number(left.broadcastScore || 0);
		});
	}
	const authorCounts = new Map();
	const seenTexts = new Set();
	return items
		.sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
		.map((candidate) => ({
			...candidate,
			broadcastScore:
				typeof candidate.broadcastScore === 'number' ?
					candidate.broadcastScore
				: scoreCandidate({ candidate, authorCounts, seenTexts }),
		}))
		.sort((left, right) => {
			const featuredDelta = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
			if (featuredDelta !== 0) return featuredDelta;
			const scoreDelta = Number(right.broadcastScore || 0) - Number(left.broadcastScore || 0);
			if (scoreDelta !== 0) return scoreDelta;
			return new Date(right.createdAt) - new Date(left.createdAt);
		});
};

const resolveBroadcastSurveyContext = async (surveyId) => {
	const objectId = ensureObjectId(surveyId);
	let survey = await Survey.findById(objectId).lean();
	let surveyModel = 'Survey';
	if (!survey) {
		survey = await Survey2.findById(objectId).lean();
		surveyModel = 'Survey_2';
	}
	if (!survey) {
		const error = new Error('Survey not found');
		error.status = 404;
		throw error;
	}
	const organizationId = await resolveSurveyOrganizationId(survey);
	const surveyKind = normalizeSurveyKind({ surveyModel, survey });
	const opinionModelInfo = getOpinionModelBySurveyKind(surveyKind);
	const optionPayload = surveyModel === 'Survey_2' ? buildSurveyOptionPayload(survey) : null;
	return {
		surveyId: String(survey._id),
		survey,
		surveyModel,
		surveyKind,
		organizationId,
		resultRoomName: getResultRoomName({ surveyId: survey._id, surveyKind }),
		isFlash: survey.explain === false,
		type: surveyModel === 'Survey_2' ? 'multiple' : 'binary',
		opinionModel: opinionModelInfo.model,
		opinionModelName: opinionModelInfo.name,
		optionPayload,
		meta: {
			id: String(survey._id),
			theme: survey.theme || '',
			question: survey.question || '',
			contexte: survey.contexte || '',
			status: normalizeSurveyStatus(survey.status),
			isClosed: Boolean(survey.isClosed),
			createdAt: toIsoString(survey.createdAt),
			endedAt: toIsoString(survey.endedAt),
			mode: normalizeMode(survey),
			type: surveyModel === 'Survey_2' ? 'multiple' : 'binary',
			options: optionPayload?.options || [],
			optionKeys: optionPayload?.optionKeys || [],
			labels: optionPayload?.labels || {},
		},
	};
};

const assertUserCanManageBroadcastSurvey = async ({ surveyContext, userId }) => {
	const allowed = await canManageSurveyByOrganization(surveyContext.survey, userId);
	if (!allowed) {
		const error = new Error('Forbidden');
		error.status = 403;
		throw error;
	}
};

const buildBroadcastResultsPayload = async (surveyContext) => {
	const surveyId = ensureObjectId(surveyContext.survey._id);
	if (surveyContext.type === 'binary') {
		const statusFilter = buildStatusFilter('clean');
		const [yes, no] = await Promise.all([
			surveyContext.opinionModel.countDocuments({ surveyId, answer: true, ...statusFilter }),
			surveyContext.opinionModel.countDocuments({ surveyId, answer: false, ...statusFilter }),
		]);
		return {
			surveyId: String(surveyContext.survey._id),
			surveyType: surveyContext.surveyKind,
			type: 'binary',
			mode: surveyContext.meta.mode,
			theme: surveyContext.meta.theme,
			question: surveyContext.meta.question,
			contexte: surveyContext.meta.contexte,
			status: surveyContext.meta.status,
			isClosed: surveyContext.meta.isClosed,
			totalOpinions: Number(yes || 0) + Number(no || 0),
			counts: { yes: Number(yes || 0), no: Number(no || 0) },
			updatedAt: new Date().toISOString(),
		};
	}

	const statusFilter = buildStatusFilter('clean');
	const counts = surveyContext.meta.optionKeys.reduce((accumulator, key) => {
		accumulator[key] = 0;
		return accumulator;
	}, {});
	const rows = await surveyContext.opinionModel.aggregate([
		{
			$match: {
				surveyId,
				...statusFilter,
			},
		},
		{ $group: { _id: '$answer', total: { $sum: 1 } } },
	]);
	for (const row of rows || []) {
		const key = String(row?._id || '').trim();
		if (Object.prototype.hasOwnProperty.call(counts, key)) {
			counts[key] = Number(row.total || 0);
		}
	}
	const totalOpinions = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
	return {
		surveyId: String(surveyContext.survey._id),
		surveyType: surveyContext.surveyKind,
		type: 'multiple',
		mode: surveyContext.meta.mode,
		theme: surveyContext.meta.theme,
		question: surveyContext.meta.question,
		contexte: surveyContext.meta.contexte,
		status: surveyContext.meta.status,
		isClosed: surveyContext.meta.isClosed,
		options: surveyContext.meta.options,
		optionKeys: surveyContext.meta.optionKeys,
		labels: surveyContext.meta.labels,
		counts,
		totalOpinions,
		updatedAt: new Date().toISOString(),
	};
};

const loadCueMapForSurvey = async (surveyId) => {
	const activeCues = await BroadcastCue.find({
		surveyId,
		airState: { $in: ['approved', 'featured'] },
		removedAt: null,
		expiredAt: null,
	})
		.sort({ airState: 1, airOrder: 1, approvedAt: -1 })
		.lean();
	const cueMap = new Map();
	for (const cue of activeCues) {
		cueMap.set(`${cue.sourceType}:${String(cue.sourceId)}`, cue);
	}
	return { activeCues, cueMap };
};

const listBroadcastCandidates = async ({
	surveyContext,
	source = 'all',
	state = 'all',
	search = '',
	sort = 'recommended',
	limit = 160,
} = {}) => {
	const surveyId = ensureObjectId(surveyContext.survey._id);
	const [chatDocs, opinionDocs, cueState] = await Promise.all([
		source === 'survey_comment'
			? []
			: ChatMessage.find({
					surveyId,
					surveyModel: surveyContext.surveyModel,
					isSystemMessage: { $ne: true },
				})
					.sort({ createdAt: -1 })
					.limit(MAX_SOURCE_RESULTS)
					.select('_id surveyId surveyModel userPseudo message createdAt likes dislikes isSystemMessage')
					.lean(),
		source === 'chat_message'
			? []
			: surveyContext.opinionModel
					.find({
						surveyId,
						...buildStatusFilter('clean'),
						commentDeletedAt: null,
					})
					.sort({ createdAt: -1 })
					.limit(MAX_SOURCE_RESULTS)
					.select('_id answer reason userPseudo createdAt likes dislikes fraudStatus commentDeletedAt commentDeletedSource')
					.lean(),
		loadCueMapForSurvey(surveyId),
	]);

	const candidates = [];
	for (const chatDoc of chatDocs || []) {
		const candidate = buildChatCandidate(chatDoc, surveyContext);
		if (candidate) candidates.push(candidate);
	}
	for (const opinionDoc of opinionDocs || []) {
		const candidate = buildSurveyCommentCandidate(opinionDoc, surveyContext);
		if (candidate) candidates.push(candidate);
	}

	const loweredSearch = String(search || '').trim().toLowerCase();
	const hydrated = candidates.map((candidate) => {
		const cue = cueState.cueMap.get(`${candidate.sourceType}:${candidate.sourceId}`);
		const broadcastState = cue?.airState === 'featured' ? 'featured' : cue ? 'approved' : 'eligible';
		return {
			...candidate,
			broadcastState,
			featured: cue?.airState === 'featured',
			cueId: cue ? String(cue._id) : null,
			airOrder: cue ? Number(cue.airOrder || 0) : 0,
			broadcastScore: cue ? Number(cue.broadcastScore || 0) : undefined,
		};
	});

	const filtered = hydrated.filter((candidate) => {
		if (state !== 'all' && String(candidate.broadcastState) !== String(state)) return false;
		if (!loweredSearch) return true;
		const haystack = [candidate.pseudoSnapshot, candidate.textSnapshot, candidate.answerSnapshot]
			.filter(Boolean)
			.join(' ')
			.toLowerCase();
		return haystack.includes(loweredSearch);
	});

	return sortCandidates(filtered, sort).slice(0, Math.max(1, Math.min(Number(limit || 160), 250)));
};

const findCandidateSource = async ({ surveyContext, sourceType, sourceId }) => {
	const objectId = ensureObjectId(sourceId);
	if (sourceType === 'chat_message') {
		const chatDoc = await ChatMessage.findOne({
			_id: objectId,
			surveyId: surveyContext.survey._id,
			surveyModel: surveyContext.surveyModel,
		})
			.select('_id surveyId surveyModel userPseudo message createdAt likes dislikes isSystemMessage')
			.lean();
		return chatDoc ? buildChatCandidate(chatDoc, surveyContext) : null;
	}
	if (sourceType === 'survey_comment') {
		const opinionDoc = await surveyContext.opinionModel
			.findOne({ _id: objectId, surveyId: surveyContext.survey._id })
			.select('_id answer reason userPseudo createdAt likes dislikes fraudStatus commentDeletedAt commentDeletedSource')
			.lean();
		return opinionDoc ? buildSurveyCommentCandidate(opinionDoc, surveyContext) : null;
	}
	return null;
};

module.exports = {
	ensureObjectId,
	resolveBroadcastSurveyContext,
	assertUserCanManageBroadcastSurvey,
	buildBroadcastResultsPayload,
	listBroadcastCandidates,
	findCandidateSource,
	serializeCue,
	scoreCandidate,
	loadCueMapForSurvey,
	MAX_SOURCE_RESULTS,
	CHAT_SURVEY_MODEL_TO_TYPE,
};

