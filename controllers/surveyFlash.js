/** @format */

const Survey = require('../models/Survey');
const OpinionFlash = require('../models/Opinion_Flash');

const canManageSurvey = (survey, req) =>
	req.userRole === 'admin' ||
	String(survey.userId) === String(req.userId);

const formatOpinion = (opinion, userId) => {
	const likeCount = (opinion.likes && opinion.likes.length) || 0;
	const dislikeCount = (opinion.dislikes && opinion.dislikes.length) || 0;

	const userLiked = userId
		? (opinion.likes || []).some((id) => String(id) === String(userId))
		: false;

	const userDisliked = userId
		? (opinion.dislikes || []).some((id) => String(id) === String(userId))
		: false;

	return {
		...opinion,
		likeCount,
		dislikeCount,
		userLiked,
		userDisliked,
	};
};

async function buildBinaryCounts(surveyId) {
	const [yes, no] = await Promise.all([
		OpinionFlash.countDocuments({ surveyId, answer: true }),
		OpinionFlash.countDocuments({ surveyId, answer: false }),
	]);

	return {
		totalOpinions: yes + no,
		counts: { yes, no },
	};
}

exports.getState = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res
				.status(400)
				.json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const hasParticipated = Boolean(
			await OpinionFlash.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);

		const canViewResults = hasParticipated || canManageSurvey(survey, req);
		const canVote = !survey.isClosed && !hasParticipated;

		const payload = {
			survey,
			type: 'binary',
			hasParticipated,
			canVote,
			canViewResults,
			isClosed: Boolean(survey.isClosed),
		};

		if (survey.isClosed && !canViewResults) {
			payload.message =
				'Ce sondage est clôturé. Les résultats sont réservés aux votants.';
		}

		res.status(200).json(payload);
	} catch (error) {
		console.error('surveyFlash.getState error:', error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.submitOpinion = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id);
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res
				.status(400)
				.json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		if (survey.isClosed) {
			return res.status(403).json({
				message: 'Le sondage est clôturé, vous ne pouvez plus y répondre.',
			});
		}

		if (typeof req.body.answer !== 'boolean') {
			return res.status(400).json({ message: 'Réponse invalide.' });
		}

		const already = await OpinionFlash.findOne({
			surveyId: survey._id,
			userId: req.userId,
		})
			.select('_id')
			.lean();

		if (already) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des résultats.',
			});
		}

		const reason =
			typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

		const opinion = new OpinionFlash({
			answer: req.body.answer,
			reason: reason || undefined,
			surveyId: survey._id,
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		await opinion.save();

		const io = req.app.get('io');
		const room = `flash-binary-${survey._id}`;
		const countsPayload = await buildBinaryCounts(survey._id);

		if (reason) {
			io.to(room).emit('flash:new-opinion', {
				_id: opinion._id,
				answer: opinion.answer,
				reason: opinion.reason || '',
				surveyId: String(opinion.surveyId),
				userId: String(opinion.userId),
				userPseudo: opinion.userPseudo,
				createdAt: opinion.createdAt,
				likeCount: 0,
				dislikeCount: 0,
				userLiked: false,
				userDisliked: false,
			});
		}

		io.to(room).emit('flash:counts', {
			surveyId: String(survey._id),
			type: 'binary',
			totalOpinions: countsPayload.totalOpinions,
			counts: countsPayload.counts,
			isClosed: Boolean(survey.isClosed),
		});

		res.status(201).json({
			message: 'Opinion enregistrée !',
			hasParticipated: true,
			canVote: false,
		});
	} catch (error) {
		if (error && error.code === 11000) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des résultats.',
			});
		}
		console.error('surveyFlash.submitOpinion error:', error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getDetailedResults = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res
				.status(400)
				.json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const hasParticipated = Boolean(
			await OpinionFlash.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);

		const canViewResults = hasParticipated || canManageSurvey(survey, req);
		if (!canViewResults) {
			if (survey.isClosed) {
				return res.status(403).json({
					message:
						'Ce sondage est clôturé. Les résultats sont réservés aux votants.',
				});
			}
			return res
				.status(403)
				.json({ message: 'Votez pour accéder aux résultats en temps réel.' });
		}

		const opinions = await OpinionFlash.find({ surveyId: survey._id })
			.sort({ createdAt: -1 })
			.lean();

		const enrichedOpinions = opinions.map((opinion) =>
			formatOpinion(opinion, req.userId),
		);

		const yes = enrichedOpinions.filter((op) => op.answer === true).length;
		const no = enrichedOpinions.length - yes;

		res.status(200).json({
			survey,
			type: 'binary',
			isClosed: Boolean(survey.isClosed),
			hasParticipated,
			canVote: !survey.isClosed && !hasParticipated,
			totalOpinions: enrichedOpinions.length,
			counts: { yes, no },
			opinions: enrichedOpinions,
		});
	} catch (error) {
		console.error('surveyFlash.getDetailedResults error:', error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
