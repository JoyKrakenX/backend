/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');

exports.getMySurveys = async (req, res, next) => {
	try {
		const userId = req.userId;
		const binary = await Survey.find({ userId }).lean();
		const multiple = await Survey_2.find({ userId }).lean();

		const formattedBinary = binary.map((s) => ({
			...s,
			type: 'binary',
		}));

		const formattedMultiple = multiple.map((s) => ({
			...s,
			type: 'multiple',
		}));

		const all = [...formattedBinary, ...formattedMultiple];

		all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

		res.status(200).json(all);
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
