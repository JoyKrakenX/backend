/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');

const settledValueOr = (result, fallback) =>
	result && result.status === 'fulfilled' ? result.value : fallback;

exports.getAllSurveys = async (req, res, next) => {
	try {
		const userId = req.userId || null;
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
			type: 'binary',
			hasParticipated:
				s.explain === false ?
					binaryFlashParticipationSet.has(String(s._id))
				:	binaryParticipationSet.has(String(s._id)),
		}));

		const formattedMultiple = surveysMultiple.map((s) => ({
			...s,
			type: 'multiple',
			hasParticipated:
				s.explain === false ?
					multipleFlashParticipationSet.has(String(s._id))
				:	multipleParticipationSet.has(String(s._id)),
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
