/** @format */

const Survey = require('../models/Survey');
const Opinion = require('../models/Opinion');
const Survey_2 = require('../models/Survey_2');

const mongoose = require('mongoose');

exports.createSurvey = async (req, res, next) => {
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
			question: req.body.question,
			userId: req.userId,
		});

		const savedSurvey = await survey.save();
		res
			.status(201)
			.json({ message: 'Survey saved !', surveyId: savedSurvey._id });
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

exports.getOneSurvey = (req, res, next) => {
	const id = req.params.id;

	// Vérifier que c'est un ObjectId valide
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

exports.submitOpinion = async (req, res, next) => {
	try {
		console.log('=== DÉBUT submitOpinion ===');
		console.log('Headers:', req.headers);
		console.log('User ID:', req.userId);
		console.log('User Pseudo:', req.userPseudo);
		console.log('Survey ID:', req.params.id);
		console.log('Body:', req.body);

		const surveyId = req.params.id;
		const survey = await Survey.findById(surveyId);

		if (!survey) {
			console.log('Sondage non trouvé');
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		console.log('Sondage trouvé, isClosed:', survey.isClosed);

		if (survey.isClosed) {
			return res.status(403).json({
				message: 'Le sondage est clôturé, vous ne pouvez plus y répondre.',
			});
		}

		const existingOpinion = await Opinion.findOne({
			surveyId: mongoose.Types.ObjectId.createFromHexString(surveyId),

			userId: req.userId,
		});

		console.log('Opinion existante:', existingOpinion);

		if (existingOpinion) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des réultats.',
			});
		}

		if (typeof req.body.answer !== 'boolean') {
			console.log('Réponse invalide (pas booléen):', req.body.answer);
			return res.status(400).json({ message: 'Réponse invalide.' });
		}

		if (!req.body.reason || req.body.reason.trim() === '') {
			console.log('Raison manquante ou vide');
			return res.status(400).json({ message: 'La raison est obligatoire.' });
		}

		const opinion = new Opinion({
			answer: req.body.answer,
			reason: req.body.reason,
			surveyId: mongoose.Types.ObjectId.createFromHexString(surveyId),
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		console.log('Opinion à sauvegarder:', opinion);

		await opinion.save();
		console.log('Opinion sauvegardée avec succès');

		res.status(201).json({ message: 'Opinion enregistrée !' });
	} catch (err) {
		console.error('ERREUR dans submitOpinion:', err);
		console.error('Stack trace:', err.stack);
		res.status(500).json({ error: err.message });
	}
};

exports.getFlashStats = (req, res, next) => {
	Opinion.find({ surveyId: req.params.id })
		.then((results) => {
			const totalOpinions = results.length;
			res.status(200).json({ totalOpinions });
		})
		.catch((error) => res.status(400).json({ error }));
};

exports.getDetailedStats = async (req, res, next) => {
	try {
		const results = await Opinion.find({ surveyId: req.params.id }).lean();

		const enriched = results.map((op) => {
			const likeCount = (op.likes && op.likes.length) || 0;
			const dislikeCount = (op.dislikes && op.dislikes.length) || 0;

			const userLiked =
				req.userId ?
					(op.likes || []).some((id) => id.toString() === req.userId)
				:	false;

			const userDisliked =
				req.userId ?
					(op.dislikes || []).some((id) => id.toString() === req.userId)
				:	false;

			return {
				...op,
				likeCount,
				dislikeCount,
				userLiked,
				userDisliked,
			};
		});

		res.json({
			totalOpinions: results.length,
			opinions: enriched,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.closeSurvey = async (req, res, next) => {
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

		res.status(200).json({ message: 'Sondage clôturé avec succès' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Erreur serveur' });
	}
};
