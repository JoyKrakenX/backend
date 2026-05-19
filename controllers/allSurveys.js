/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const User = require('../models/User');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
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

const SURVEY_LIST_PROJECTION =
	'_id theme question contexte explain status createdAt userId organizationId isClosed endedAt';

const settledValueOr = (result, fallback) =>
	result && result.status === 'fulfilled' ? result.value : fallback;

const toSurveyIds = (surveys) =>
	Array.isArray(surveys) ? surveys.map((survey) => survey?._id).filter(Boolean) : [];

const countOpinionsBySurvey = async (OpinionModel, surveyIds = []) =>
	aggregateCountBySurvey(OpinionModel, surveyIds, 'clean');

const distinctSurveyParticipation = async (OpinionModel, userId) => {
	if (!userId) return [];
	return OpinionModel.distinct('surveyId', {
		userId,
	});
};

const toUniqueStringArray = (values = []) =>
	[...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];

const getCreatorIds = (...surveyGroups) =>
	[
		...new Set(
			surveyGroups
				.flat()
				.map((survey) => String(survey?.userId || '').trim())
				.filter(Boolean),
		),
	];

const getCreatorsById = async (surveysBinary = [], surveysMultiple = []) => {
	const creatorIds = getCreatorIds(surveysBinary, surveysMultiple);
	if (!creatorIds.length) return new Map();

	const users = await User.find({ _id: { $in: creatorIds } })
		.select('_id pseudo name email')
		.lean();

	return new Map(users.map((user) => [String(user._id), user]));
};

const resolveCreatorName = (survey, creatorsById) => {
	const creator = creatorsById.get(String(survey?.userId || '').trim());
	const emailFallback = String(creator?.email || '').split('@')[0];
	const name = String(
		creator?.pseudo || creator?.name || emailFallback || 'Administrateur',
	).trim();
	return name || 'Administrateur';
};

exports.getAllSurveys = async (req, res, next) => {
	try {
		const userId = req.userId || null;
		if (!userId) {
			return res.status(200).json([]);
		}

		const [
			binaryParticipations,
			multipleParticipations,
			binaryFlashParticipations,
			multipleFlashParticipations,
		] = await Promise.all([
			distinctSurveyParticipation(Opinion, userId),
			distinctSurveyParticipation(Opinion_2, userId),
			distinctSurveyParticipation(Opinion_Flash, userId),
			distinctSurveyParticipation(Opinion_2_Flash, userId),
		]);

		const participatedSurveyIdsByModel = {
			binary: toUniqueStringArray([
				...binaryParticipations,
				...binaryFlashParticipations,
			]),
			multiple: toUniqueStringArray([
				...multipleParticipations,
				...multipleFlashParticipations,
			]),
		};

		if (
			!participatedSurveyIdsByModel.binary.length &&
			!participatedSurveyIdsByModel.multiple.length
		) {
			return res.status(200).json([]);
		}

		const settled = await Promise.allSettled([
			Survey.find({ _id: { $in: participatedSurveyIdsByModel.binary } })
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.lean(),
			Survey_2.find({ _id: { $in: participatedSurveyIdsByModel.multiple } })
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.lean(),
		]);

		settled.forEach((entry, index) => {
			if (entry.status === 'rejected') {
				console.warn(
					`allSurveys partial failure [${index}]`,
					entry.reason?.message || entry.reason || 'unknown',
				);
			}
		});

		const surveysBinary = settledValueOr(settled[0], []);
		const surveysMultiple = settledValueOr(settled[1], []);
		const creatorsById = await getCreatorsById(surveysBinary, surveysMultiple);
		const binaryIds = toSurveyIds(surveysBinary);
		const multipleIds = toSurveyIds(surveysMultiple);

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
			type: 'binary',
			creatorName: resolveCreatorName(survey, creatorsById),
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
			type: 'multiple',
			creatorName: resolveCreatorName(survey, creatorsById),
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
