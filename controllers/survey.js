/** @format */

const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Opinion = require('../models/Opinion');
const OpinionFlash = require('../models/Opinion_Flash');
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

const getBinaryOpinionModel = (survey) =>
	survey && survey.explain === false ? OpinionFlash : Opinion;

const toObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));

async function getBinaryCounts(surveyId, OpinionModel) {
	const [yesCount, noCount] = await Promise.all([
		OpinionModel.countDocuments({ surveyId, answer: true }),
		OpinionModel.countDocuments({ surveyId, answer: false }),
	]);

	return {
		yesCount,
		noCount,
		totalOpinions: yesCount + noCount,
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

		const survey = new Survey({
			theme: realTheme,
			contexte: req.body.contexte,
			question: normalizeQuestion(req.body.question),
			explain: parseExplainFlag(req.body.explain),
			userId: req.userId,
		});

		const savedSurvey = await survey.save();

		broadcastSurveyNewPush({
			surveyId: savedSurvey._id,
			surveyType: 'binary',
			theme: savedSurvey.theme,
			creatorName: req.userPseudo || 'Administrateur',
			excludeUserId: req.userId,
		}).catch((error) =>
			console.error('push survey.new binary failed:', error?.message || error),
		);

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'created',
			surveyId: savedSurvey._id,
			type: 'binary',
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

	Survey.findById(id)
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
		const survey = await Survey.findById(surveyId);

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

		const existingOpinion = await Opinion.findOne({
			surveyId: toObjectId(surveyId),
			userId: req.userId,
		});

		if (existingOpinion) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des résultats.',
			});
		}

		if (typeof req.body.answer !== 'boolean') {
			return res.status(400).json({ message: 'Réponse invalide.' });
		}

		if (!req.body.reason || req.body.reason.trim() === '') {
			return res.status(400).json({ message: 'La raison est obligatoire.' });
		}

		const opinion = new Opinion({
			answer: req.body.answer,
			reason: req.body.reason,
			surveyId: toObjectId(surveyId),
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		await opinion.save();

		res.status(201).json({ message: 'Opinion enregistrée !' });
	} catch (err) {
		console.error('ERREUR dans submitOpinion:', err);
		console.error('Stack trace:', err.stack);
		res.status(500).json({ error: err.message });
	}
};

exports.getFlashStats = async (req, res) => {
	try {
		const surveyId = req.params.id;
		const survey = await Survey.findById(surveyId).select('explain').lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const OpinionModel = getBinaryOpinionModel(survey);
		const totalOpinions = await OpinionModel.countDocuments({ surveyId });

		res.status(200).json({ totalOpinions });
	} catch (error) {
		console.error(error);
		res.status(400).json({ error });
	}
};

exports.getDetailedStats = async (req, res) => {
	try {
		const surveyId = req.params.id;
		const survey = await Survey.findById(surveyId).select('explain').lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const OpinionModel = getBinaryOpinionModel(survey);
		const results = await OpinionModel.find({ surveyId }).lean();

		const enriched = results.map((op) => {
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

		const yesCount = enriched.filter((op) => op.answer === true).length;
		const noCount = enriched.length - yesCount;

		res.json({
			totalOpinions: enriched.length,
			yesCount,
			noCount,
			opinions: enriched,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.closeSurvey = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id);

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.userId.toString() !== req.userId.toString()) {
			return res.status(403).json({ message: 'Non autorisé' });
		}

		if (survey.isClosed) {
			return res.status(400).json({ message: 'Le sondage est déjà clôturé' });
		}

		survey.isClosed = true;
		survey.endedAt = new Date();

		await survey.save();

		const OpinionModel = getBinaryOpinionModel(survey);
		const participantUserIds = await OpinionModel.distinct('userId', {
			surveyId: survey._id,
		});

		broadcastSurveyClosedPush({
			surveyId: survey._id,
			surveyType: 'binary',
			theme: survey.theme,
			participantUserIds,
		}).catch((error) =>
			console.error('push survey.closed binary failed:', error?.message || error),
		);

		if (survey.explain === false) {
			const io = req.app.get('io');
			const room = `flash-binary-${survey._id}`;
			const counts = await getBinaryCounts(survey._id, OpinionFlash);

			io.to(room).emit('flash:counts', {
				surveyId: String(survey._id),
				type: 'binary',
				totalOpinions: counts.totalOpinions,
				counts: { yes: counts.yesCount, no: counts.noCount },
				isClosed: true,
			});

			io.to(room).emit('flash:closed', {
				surveyId: String(survey._id),
				type: 'binary',
				endedAt: survey.endedAt,
			});
		}

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'closed',
			surveyId: survey._id,
			type: 'binary',
			explain: survey.explain,
			isClosed: true,
			ownerUserId: survey.userId,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
		});

		res.status(200).json({ message: 'Sondage clôturé avec succès' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Erreur serveur' });
	}
};
