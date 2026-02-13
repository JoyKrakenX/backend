/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');

exports.getAllSurveys = async (req, res, next) => {
	try {
		const surveysBinary = await Survey.find().lean();
		const surveysMultiple = await Survey_2.find().lean();

		const formattedBinary = surveysBinary.map((s) => ({
			...s,
			type: 'binary',
		}));

		const formattedMultiple = surveysMultiple.map((s) => ({
			...s,
			type: 'multiple',
		}));

		const allSurveys = [...formattedBinary, ...formattedMultiple];

		allSurveys.sort((a, b) => {
			return new Date(b.createdAt) - new Date(a.createdAt);
		});
		res.status(200).json(allSurveys);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
