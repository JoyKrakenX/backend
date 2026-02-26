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

const settledValueOr = (result, fallback) =>
	result && result.status === 'fulfilled' ? result.value : fallback;

const toSurveyIds = (surveys) =>
	Array.isArray(surveys) ? surveys.map((survey) => survey?._id).filter(Boolean) : [];

const countOpinionsBySurvey = async (OpinionModel, surveyIds = []) => {
	if (!surveyIds.length) return new Map();
	const rows = await OpinionModel.aggregate([
		{
			$match: {
				surveyId: { $in: surveyIds },
			},
		},
		{
			$group: {
				_id: '$surveyId',
				count: { $sum: 1 },
			},
		},
	]);

	return new Map(rows.map((row) => [String(row._id), Number(row.count) || 0]));
};

exports.getAllSurveys = async (req, res, next) => {
	try {
		const userId = req.userId || null;
		const requesterUserId = userId ? String(userId) : '';
		const settled = await Promise.allSettled([
			Survey.find().lean(),
			Survey_2.find().lean(),
			userId ? Opinion.distinct('surveyId', { userId }) : [],
			userId ? Opinion_2.distinct('surveyId', { userId }) : [],
			userId ? Opinion_Flash.distinct('surveyId', { userId }) : [],
			userId ? Opinion_2_Flash.distinct('surveyId', { userId }) : [],
		]);

		const surveysBinary = settledValueOr(settled[0], []);
		const surveysMultiple = settledValueOr(settled[1], []);
		const binaryParticipations = settledValueOr(settled[2], []);
		const multipleParticipations = settledValueOr(settled[3], []);
		const binaryFlashParticipations = settledValueOr(settled[4], []);
		const multipleFlashParticipations = settledValueOr(settled[5], []);

		settled.forEach((entry, index) => {
			if (entry.status === 'rejected') {
				console.warn(
					`allSurveys partial failure [${index}]`,
					entry.reason?.message || entry.reason || 'unknown',
				);
			}
		});

		const binaryClassic = surveysBinary.filter((survey) => survey.explain !== false);
		const binaryFlash = surveysBinary.filter((survey) => survey.explain === false);
		const multipleClassic = surveysMultiple.filter((survey) => survey.explain !== false);
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

		const formattedBinary = surveysBinary.map((s) => ({
			...s,
			status: normalizeSurveyStatus(s.status),
			type: 'binary',
			totalVotes:
				s.explain === false ?
					binaryFlashCounts.get(String(s._id)) || 0
				:	binaryClassicCounts.get(String(s._id)) || 0,
			opinionsCount:
				s.explain === false ?
					binaryFlashCounts.get(String(s._id)) || 0
				:	binaryClassicCounts.get(String(s._id)) || 0,
			hasParticipated:
				s.explain === false ?
					binaryFlashParticipationSet.has(String(s._id))
				:	binaryParticipationSet.has(String(s._id)),
		}));

		const formattedMultiple = surveysMultiple.map((s) => ({
			...s,
			status: normalizeSurveyStatus(s.status),
			type: 'multiple',
			totalVotes:
				s.explain === false ?
					multipleFlashCounts.get(String(s._id)) || 0
				:	multipleClassicCounts.get(String(s._id)) || 0,
			opinionsCount:
				s.explain === false ?
					multipleFlashCounts.get(String(s._id)) || 0
				:	multipleClassicCounts.get(String(s._id)) || 0,
			hasParticipated:
				s.explain === false ?
					multipleFlashParticipationSet.has(String(s._id))
				:	multipleParticipationSet.has(String(s._id)),
		}));

		const allSurveys = [...formattedBinary, ...formattedMultiple].filter(
			(survey) => {
				const normalizedStatus = normalizeSurveyStatus(survey.status);
				if (isSurveyPublic(normalizedStatus)) return true;

				if (!survey.isClosed) return false;
				const isOwner =
					Boolean(requesterUserId) &&
					String(survey.userId || '') === requesterUserId;
				return Boolean(survey.hasParticipated || isOwner);
			},
		);

		allSurveys.sort((a, b) => {
			return new Date(b.createdAt) - new Date(a.createdAt);
		});
		res.status(200).json(allSurveys);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
