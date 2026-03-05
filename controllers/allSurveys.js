/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
const {
	normalizeSurveyStatus,
	isSurveyPublic,
} = require('../utils/surveyStatus');
const { aggregateCountBySurvey } = require('../services/fraud/opinionFilterService');

const DEFAULT_ALL_SURVEYS_MAX_ITEMS = 500;
const ALL_SURVEYS_MIN_ITEMS = 50;
const ALL_SURVEYS_MAX_ALLOWED_ITEMS = 3000;
const ALL_SURVEYS_MAX_ITEMS = (() => {
	const parsed = Number.parseInt(process.env.ALL_SURVEYS_MAX_ITEMS || '', 10);
	if (!Number.isFinite(parsed)) return DEFAULT_ALL_SURVEYS_MAX_ITEMS;
	return Math.min(
		Math.max(parsed, ALL_SURVEYS_MIN_ITEMS),
		ALL_SURVEYS_MAX_ALLOWED_ITEMS,
	);
})();

const MAX_ITEMS_PER_MODEL = Math.max(
	ALL_SURVEYS_MIN_ITEMS,
	Math.ceil(ALL_SURVEYS_MAX_ITEMS * 1.2),
);

const SURVEY_LIST_PROJECTION =
	'_id theme question contexte explain status createdAt userId organizationId isClosed endedAt';

const settledValueOr = (result, fallback) =>
	result && result.status === 'fulfilled' ? result.value : fallback;

const toSurveyIds = (surveys) =>
	Array.isArray(surveys) ? surveys.map((survey) => survey?._id).filter(Boolean) : [];

const countOpinionsBySurvey = async (OpinionModel, surveyIds = []) =>
	aggregateCountBySurvey(OpinionModel, surveyIds, 'clean');

const distinctSurveyParticipation = async (
	OpinionModel,
	userId,
	limitedSurveyIds = [],
) => {
	if (!userId || !limitedSurveyIds.length) return [];
	return OpinionModel.distinct('surveyId', {
		userId,
		surveyId: { $in: limitedSurveyIds },
	});
};

exports.getAllSurveys = async (req, res, next) => {
	try {
		const userId = req.userId || null;
		const requesterUserId = userId ? String(userId) : '';

		const settled = await Promise.allSettled([
			Survey.find({})
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.limit(MAX_ITEMS_PER_MODEL)
				.lean(),
			Survey_2.find({})
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.limit(MAX_ITEMS_PER_MODEL)
				.lean(),
		]);

		const surveysBinary = settledValueOr(settled[0], []);
		const surveysMultiple = settledValueOr(settled[1], []);

		settled.forEach((entry, index) => {
			if (entry.status === 'rejected') {
				console.warn(
					`allSurveys partial failure [${index}]`,
					entry.reason?.message || entry.reason || 'unknown',
				);
			}
		});

		const binaryIds = toSurveyIds(surveysBinary);
		const multipleIds = toSurveyIds(surveysMultiple);

		const [
			binaryParticipations,
			multipleParticipations,
			binaryFlashParticipations,
			multipleFlashParticipations,
		] = await Promise.all([
			distinctSurveyParticipation(Opinion, userId, binaryIds),
			distinctSurveyParticipation(Opinion_2, userId, multipleIds),
			distinctSurveyParticipation(Opinion_Flash, userId, binaryIds),
			distinctSurveyParticipation(Opinion_2_Flash, userId, multipleIds),
		]);

		const binaryClassic = surveysBinary.filter((survey) => survey.explain !== false);
		const binaryFlash = surveysBinary.filter((survey) => survey.explain === false);
		const multipleClassic = surveysMultiple.filter(
			(survey) => survey.explain !== false,
		);
		const multipleFlash = surveysMultiple.filter((survey) => survey.explain === false);

		const voteSettled = await Promise.allSettled([
			countOpinionsBySurvey(Opinion, toSurveyIds(binaryClassic)),
			countOpinionsBySurvey(Opinion_Flash, toSurveyIds(binaryFlash)),
			countOpinionsBySurvey(Opinion_2, toSurveyIds(multipleClassic)),
			countOpinionsBySurvey(Opinion_2_Flash, toSurveyIds(multipleFlash)),
		]);

		const binaryClassicCounts = settledValueOr(voteSettled[0], new Map());
		const binaryFlashCounts = settledValueOr(voteSettled[1], new Map());
		const multipleClassicCounts = settledValueOr(voteSettled[2], new Map());
		const multipleFlashCounts = settledValueOr(voteSettled[3], new Map());

		voteSettled.forEach((entry, index) => {
			if (entry.status === 'rejected') {
				console.warn(
					`allSurveys votes partial failure [${index}]`,
					entry.reason?.message || entry.reason || 'unknown',
				);
			}
		});

		const binaryParticipationSet = new Set(
			(binaryParticipations || []).map((id) => String(id)),
		);
		const multipleParticipationSet = new Set(
			(multipleParticipations || []).map((id) => String(id)),
		);
		const binaryFlashParticipationSet = new Set(
			(binaryFlashParticipations || []).map((id) => String(id)),
		);
		const multipleFlashParticipationSet = new Set(
			(multipleFlashParticipations || []).map((id) => String(id)),
		);

		const formattedBinary = surveysBinary.map((survey) => ({
			...survey,
			status: normalizeSurveyStatus(survey.status),
			type: 'binary',
			totalVotes:
				survey.explain === false ?
					binaryFlashCounts.get(String(survey._id)) || 0
				:	binaryClassicCounts.get(String(survey._id)) || 0,
			opinionsCount:
				survey.explain === false ?
					binaryFlashCounts.get(String(survey._id)) || 0
				:	binaryClassicCounts.get(String(survey._id)) || 0,
			hasParticipated:
				survey.explain === false ?
					binaryFlashParticipationSet.has(String(survey._id))
				:	binaryParticipationSet.has(String(survey._id)),
		}));

		const formattedMultiple = surveysMultiple.map((survey) => ({
			...survey,
			status: normalizeSurveyStatus(survey.status),
			type: 'multiple',
			totalVotes:
				survey.explain === false ?
					multipleFlashCounts.get(String(survey._id)) || 0
				:	multipleClassicCounts.get(String(survey._id)) || 0,
			opinionsCount:
				survey.explain === false ?
					multipleFlashCounts.get(String(survey._id)) || 0
				:	multipleClassicCounts.get(String(survey._id)) || 0,
			hasParticipated:
				survey.explain === false ?
					multipleFlashParticipationSet.has(String(survey._id))
				:	multipleParticipationSet.has(String(survey._id)),
		}));

		const allSurveys = [...formattedBinary, ...formattedMultiple]
			.filter((survey) => {
				const normalizedStatus = normalizeSurveyStatus(survey.status);
				if (isSurveyPublic(normalizedStatus)) return true;

				if (!survey.isClosed) return false;
				const isOwner =
					Boolean(requesterUserId) &&
					String(survey.userId || '') === requesterUserId;
				return Boolean(survey.hasParticipated || isOwner);
			})
			.sort((left, right) => {
				return new Date(right.createdAt) - new Date(left.createdAt);
			})
			.slice(0, ALL_SURVEYS_MAX_ITEMS);

		res.status(200).json(allSurveys);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
