/** @format */

const mongoose = require('mongoose');

const Opinion_2 = require('../models/Opinion_2');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const Survey_2 = require('../models/Survey_2');
const { normalizeQuestion } = require('../utils/questionNormalizer');
const {
	broadcastSurveyNewPush,
	broadcastSurveyClosedPush,
} = require('../services/supportPushService');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');

const parseExplainFlag = (value) => {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		return value.trim().toLowerCase() !== 'false';
	}
	if (typeof value === 'number') {
		return value !== 0;
	}
	return true;
};

const toObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

const getMultipleOpinionModel = (survey) =>
	survey && survey.explain === false ? Opinion2Flash : Opinion_2;

async function getMultipleCounts(surveyId, OpinionModel) {
	const [reponse_1, reponse_2, reponse_3] = await Promise.all([
		OpinionModel.countDocuments({ surveyId, answer: 'reponse_1' }),
		OpinionModel.countDocuments({ surveyId, answer: 'reponse_2' }),
		OpinionModel.countDocuments({ surveyId, answer: 'reponse_3' }),
	]);

	return {
		reponse_1,
		reponse_2,
		reponse_3,
		totalOpinions: reponse_1 + reponse_2 + reponse_3,
	};
}

exports.createSurvey = async (req, res) => {
	try {
		delete req.body._id;
		const theme = (req.body.theme || '').trim();
		const realTheme =
			'#' +
			theme
				.split(' ')
				.map(
					(word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
				)
				.join('');

		const survey = new Survey_2({
			theme: realTheme,
			contexte: req.body.contexte,
			question: normalizeQuestion(req.body.question),
			explain: parseExplainFlag(req.body.explain),
			reponse_1: req.body.reponse_1,
			reponse_2: req.body.reponse_2,
			reponse_3: req.body.reponse_3 || 'Autre point de vue',
			userId: req.userId,
		});

		const savedSurvey = await survey.save();

		broadcastSurveyNewPush({
			surveyId: savedSurvey._id,
			surveyType: 'multiple',
			theme: savedSurvey.theme,
			creatorName: req.userPseudo || 'Administrateur',
			excludeUserId: req.userId,
		}).catch((error) =>
			console.error('push survey.new multiple failed:', error?.message || error),
		);

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'created',
			surveyId: savedSurvey._id,
			type: 'multiple',
			explain: savedSurvey.explain,
			isClosed: Boolean(savedSurvey.isClosed),
			ownerUserId: savedSurvey.userId,
			createdAt: savedSurvey.createdAt,
			endedAt: savedSurvey.endedAt,
		});

		res.status(200).json({
			message: 'Survey saved !',
			surveyId: savedSurvey._id,
			explain: savedSurvey.explain,
		});
	} catch (error) {
		if (error && error.code === 11000) {
			return res
				.status(400)
				.json({ message: 'Un sondage avec ce thème existe déjà.' });
		}
		console.error(error);
		res.status(400).json({ error });
	}
};

exports.getOneSurvey = (req, res) => {
	const id = req.params.id;

	if (!mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({ message: 'ID invalide' });
	}

	Survey_2.findById(id)
		.then((survey) => {
			if (!survey) {
				return res.status(404).json({ message: 'Sondage introuvable' });
			}
			res.status(200).json(survey);
		})
		.catch((error) => res.status(500).json({ error }));
};

exports.submitOpinion = async (req, res) => {
	try {
		const surveyId = req.params.id;
		const survey = await Survey_2.findById(surveyId);

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain === false) {
			return res.status(400).json({
				message:
					'Ce sondage est en mode Flash. Utilisez les endpoints Flash dédiés.',
			});
		}

		if (survey.isClosed) {
			return res.status(403).json({
				message: 'Le sondage est clôturé, vous ne pouvez plus y répondre.',
			});
		}

		const existingOpinion = await Opinion_2.findOne({
			surveyId: toObjectId(surveyId),
			userId: req.userId,
		});

		if (existingOpinion) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des résultats.',
			});
		}

		if (!['reponse_1', 'reponse_2', 'reponse_3'].includes(req.body.choice)) {
			return res.status(400).json({ message: 'Réponse invalide' });
		}

		if (!req.body.reason || req.body.reason.trim() === '') {
			return res.status(400).json({ message: 'La raison est obligatoire.' });
		}

		const opinion = new Opinion_2({
			answer: req.body.choice,
			reason: req.body.reason,
			surveyId: toObjectId(surveyId),
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		await opinion.save();

		res.status(201).json({ message: 'Opinion enregistrée !' });
	} catch (err) {
		if (err.code === 11000) {
			return res
				.status(403)
				.json({ message: 'Vous avez déjà répondu à ce sondage.' });
		}
		console.error('ERREUR dans submitOpinion:', err);
		console.error('Stack trace:', err.stack);
		res.status(500).json({ error: err.message });
	}
};

exports.getFlashStats = async (req, res) => {
	try {
		const surveyId = req.params.id;
		const survey = await Survey_2.findById(surveyId).select('explain').lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const OpinionModel = getMultipleOpinionModel(survey);
		const totalOpinions = await OpinionModel.countDocuments({ surveyId });

		res.status(200).json({ totalOpinions });
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur stats sondage multiple' });
	}
};

exports.closeSurvey = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id);

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.userId?.toString() !== req.userId?.toString()) {
			return res.status(403).json({ message: 'Non autorise' });
		}

		if (survey.isClosed) {
			return res.status(400).json({ message: 'Ce sondage est déjà clôturé.' });
		}

		survey.isClosed = true;
		survey.endedAt = new Date();

		await survey.save();

		const OpinionModel = getMultipleOpinionModel(survey);
		const participantUserIds = await OpinionModel.distinct('userId', {
			surveyId: survey._id,
		});

		broadcastSurveyClosedPush({
			surveyId: survey._id,
			surveyType: 'multiple',
			theme: survey.theme,
			participantUserIds,
		}).catch((error) =>
			console.error('push survey.closed multiple failed:', error?.message || error),
		);

		if (survey.explain === false) {
			const io = req.app.get('io');
			const room = `flash-multiple-${survey._id}`;
			const counts = await getMultipleCounts(survey._id, Opinion2Flash);

			io.to(room).emit('flash:counts', {
				surveyId: String(survey._id),
				type: 'multiple',
				totalOpinions: counts.totalOpinions,
				counts: {
					reponse_1: counts.reponse_1,
					reponse_2: counts.reponse_2,
					reponse_3: counts.reponse_3,
				},
				isClosed: true,
			});

			io.to(room).emit('flash:closed', {
				surveyId: String(survey._id),
				type: 'multiple',
				endedAt: survey.endedAt,
			});
		}

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'closed',
			surveyId: survey._id,
			type: 'multiple',
			explain: survey.explain,
			isClosed: true,
			ownerUserId: survey.userId,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
		});

		res.status(200).json({ message: 'Sondage clôturé avec succès.' });
	} catch (error) {
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getDetailedStats = async (req, res) => {
	try {
		const surveyId = req.params.id;

		if (!mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'ID invalide' });
		}

		const survey = await Survey_2.findById(surveyId).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (!survey.isClosed) {
			return res.status(403).json({
				message: "Le sondage n'est pas encore clôturé. Résultats indisponibles",
			});
		}

		const OpinionModel = getMultipleOpinionModel(survey);
		const opinions = await OpinionModel.find({ surveyId }).lean();

		const counts = {
			reponse_1: 0,
			reponse_2: 0,
			reponse_3: 0,
		};

		const enrichedOpinions = opinions.map((op) => {
			if (counts[op.answer] !== undefined) counts[op.answer] += 1;

			const likeCount = (op.likes && op.likes.length) || 0;
			const dislikeCount = (op.dislikes && op.dislikes.length) || 0;

			const userLiked = req.userId
				? (op.likes || []).some((id) => id.toString() === String(req.userId))
				: false;

			const userDisliked = req.userId
				? (op.dislikes || []).some((id) => id.toString() === String(req.userId))
				: false;
			return {
				...op,
				likeCount,
				dislikeCount,
				userLiked,
				userDisliked,
			};
		});
		res.status(200).json({
			totalOpinions: opinions.length,
			labels: {
				reponse_1: survey.reponse_1,
				reponse_2: survey.reponse_2,
				reponse_3: survey.reponse_3,
			},
			counts,
			opinions: enrichedOpinions,
		});
	} catch (err) {
		console.log(err);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
