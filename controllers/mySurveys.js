/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');

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

exports.getMySurveys = async (req, res, next) => {
	try {
		const userId = req.userId;
		const binary = await Survey.find({ userId }).lean();
		const multiple = await Survey_2.find({ userId }).lean();

		const binaryClassic = binary.filter((survey) => survey.explain !== false);
		const binaryFlash = binary.filter((survey) => survey.explain === false);
		const multipleClassic = multiple.filter((survey) => survey.explain !== false);
		const multipleFlash = multiple.filter((survey) => survey.explain === false);

		const [
			binaryClassicCounts,
			binaryFlashCounts,
			multipleClassicCounts,
			multipleFlashCounts,
		] = await Promise.all([
			countOpinionsBySurvey(Opinion, toSurveyIds(binaryClassic)),
			countOpinionsBySurvey(Opinion_Flash, toSurveyIds(binaryFlash)),
			countOpinionsBySurvey(Opinion_2, toSurveyIds(multipleClassic)),
			countOpinionsBySurvey(Opinion_2_Flash, toSurveyIds(multipleFlash)),
		]);

		const formattedBinary = binary.map((s) => ({
			...s,
			type: 'binary',
			totalVotes:
				s.explain === false ?
					binaryFlashCounts.get(String(s._id)) || 0
				:	binaryClassicCounts.get(String(s._id)) || 0,
			opinionsCount:
				s.explain === false ?
					binaryFlashCounts.get(String(s._id)) || 0
				:	binaryClassicCounts.get(String(s._id)) || 0,
		}));

		const formattedMultiple = multiple.map((s) => ({
			...s,
			type: 'multiple',
			totalVotes:
				s.explain === false ?
					multipleFlashCounts.get(String(s._id)) || 0
				:	multipleClassicCounts.get(String(s._id)) || 0,
			opinionsCount:
				s.explain === false ?
					multipleFlashCounts.get(String(s._id)) || 0
				:	multipleClassicCounts.get(String(s._id)) || 0,
		}));

		const all = [...formattedBinary, ...formattedMultiple];

		all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

		res.status(200).json(all);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
