/** @format */

const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Opinion = require('../models/Opinion');
const OpinionFlash = require('../models/Opinion_Flash');
const User = require('../models/User');
const { normalizeQuestion } = require('../utils/questionNormalizer');
const {
	buildAdminProfilesByUserId,
	anonymizeOpinionsForSurvey,
	buildSurveyAlias,
} = require('../utils/commentAnonymizer');
const {
	broadcastSurveyNewPush,
	broadcastSurveyClosedPush,
} = require('../services/supportPushService');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');
const { normalizeSurveyStatus } = require('../utils/surveyStatus');

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

const canManageSurvey = (survey, req) =>
	req.userRole === 'admin' || String(survey?.userId) === String(req.userId);

const toObjectId = (id) => mongoose.Types.ObjectId.createFromHexString(String(id));
const getClassicRoom = (surveyId) => `classic-binary-${String(surveyId)}`;

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

const emitClassicBinaryCounts = (io, survey, counts, isClosed) => {
	if (!io || !survey || !counts) return;
	io.to(getClassicRoom(survey._id)).emit('classic:counts', {
		surveyId: String(survey._id),
		type: 'binary',
		totalOpinions: Number(counts.totalOpinions || 0),
		counts: {
			yes: Number(counts.yesCount || 0),
			no: Number(counts.noCount || 0),
		},
		isClosed: Boolean(isClosed),
	});
};

const emitClassicBinaryOpinion = (io, survey, opinion) => {
	const reason = String(opinion?.reason || '').trim();
	if (!io || !survey || !opinion || !reason) return;

	io.to(getClassicRoom(survey._id)).emit('classic:new-opinion', {
		_id: String(opinion._id),
		answer: Boolean(opinion.answer),
		reason,
		surveyId: String(opinion.surveyId),
		type: 'binary',
		userPseudo: buildSurveyAlias(survey._id, opinion.userId),
		createdAt: opinion.createdAt,
		likeCount: 0,
		dislikeCount: 0,
		userLiked: false,
		userDisliked: false,
		isOwnOpinion: false,
	});
};

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
			status: normalizeSurveyStatus(req.body.status),
			userId: req.userId,
		});

		const savedSurvey = await survey.save();

		broadcastSurveyNewPush({
			surveyId: savedSurvey._id,
			surveyType: 'binary',
			explain: savedSurvey.explain,
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
			status: normalizeSurveyStatus(savedSurvey.status),
			isClosed: Boolean(savedSurvey.isClosed),
			ownerUserId: savedSurvey.userId,
			createdAt: savedSurvey.createdAt,
			endedAt: savedSurvey.endedAt,
		});

		res.status(200).json({
			message: 'Survey saved !',
			surveyId: savedSurvey._id,
			explain: savedSurvey.explain,
			status: normalizeSurveyStatus(savedSurvey.status),
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

exports.getState = async (req, res) => {
	try {
		const surveyId = req.params.id;
		const survey = await Survey.findById(surveyId).lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain === false) {
			return res.status(400).json({
				message:
					'Ce sondage est en mode Flash. Utilisez les endpoints Flash dedies.',
			});
		}

		const hasParticipated = Boolean(
			await Opinion.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);
		const canManage = canManageSurvey(survey, req);
		const canVote = !survey.isClosed && !hasParticipated;
		const canViewResults = hasParticipated || canManage;
		let message = '';

		if (!canViewResults) {
			message = survey.isClosed ?
				'Ce sondage est cloture. Les resultats sont reserves aux votants.'
			:	'Votez pour acceder aux resultats en temps reel.';
		}

		return res.status(200).json({
			survey,
			type: 'binary',
			isClosed: Boolean(survey.isClosed),
			hasParticipated,
			canVote,
			canViewResults,
			message,
		});
	} catch (error) {
		console.error('survey.getState error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
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

		const io = req.app.get('io');
		const counts = await getBinaryCounts(survey._id, Opinion);
		emitClassicBinaryOpinion(io, survey, opinion);
		emitClassicBinaryCounts(io, survey, counts, survey.isClosed);

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'vote',
			surveyId: survey._id,
			type: 'binary',
			explain: survey.explain,
			status: normalizeSurveyStatus(survey.status),
			isClosed: Boolean(survey.isClosed),
			ownerUserId: survey.userId,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions: counts.totalOpinions,
			occurredAt: new Date(),
		});

		res.status(201).json({
			message: 'Opinion enregistree !',
			hasParticipated: true,
			canVote: false,
			canViewResults: true,
		});
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
		const survey = await Survey.findById(surveyId)
			.select('explain userId isClosed')
			.lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const OpinionModel = getBinaryOpinionModel(survey);
		const hasParticipated = Boolean(
			await OpinionModel.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);
		const allowAdminFilters = canManageSurvey(survey, req);
		const canViewResults = hasParticipated || allowAdminFilters;
		const canVote = !survey.isClosed && !hasParticipated;
		if (!canViewResults) {
			if (survey.isClosed) {
				return res.status(403).json({
					message: 'Ce sondage est cloture. Les resultats sont reserves aux votants.',
				});
			}
			return res.status(403).json({
				message: 'Votez pour acceder aux resultats en temps reel.',
			});
		}

		const results = await OpinionModel.find({ surveyId }).lean();
		let adminProfilesByUserId = null;

		if (allowAdminFilters) {
			const opinionUserIds = [
				...new Set(results.map((opinion) => String(opinion?.userId || '')).filter(Boolean)),
			];
			const users =
				opinionUserIds.length > 0 ?
					await User.find({ _id: { $in: opinionUserIds } })
						.select('birthdate gender')
						.lean()
				:	[];
			adminProfilesByUserId = buildAdminProfilesByUserId(users);
		}

		const enrichedRaw = results.map((op) => {
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
		const enriched = anonymizeOpinionsForSurvey(enrichedRaw, surveyId, {
			includeAdminProfile: allowAdminFilters,
			includeVoterKey: allowAdminFilters,
			adminProfilesByUserId,
			requesterUserId: req.userId,
		});

		const yesCount = enriched.filter((op) => op.answer === true).length;
		const noCount = enriched.length - yesCount;

		res.json({
			totalOpinions: enriched.length,
			yesCount,
			noCount,
			isClosed: Boolean(survey.isClosed),
			hasParticipated,
			canVote,
			canViewResults: true,
			meta: {
				demographicFiltersAvailable: allowAdminFilters,
				demographicFilterMode: 'age_gender',
			},
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
			explain: survey.explain,
			theme: survey.theme,
			participantUserIds,
		}).catch((error) =>
			console.error('push survey.closed binary failed:', error?.message || error),
		);

		let finalTotalOpinions = null;
		const io = req.app.get('io');

		if (survey.explain === false) {
			const room = `flash-binary-${survey._id}`;
			const counts = await getBinaryCounts(survey._id, OpinionFlash);
			finalTotalOpinions = counts.totalOpinions;

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
		} else {
			const counts = await getBinaryCounts(survey._id, Opinion);
			finalTotalOpinions = counts.totalOpinions;
			emitClassicBinaryCounts(io, survey, counts, true);
			io.to(getClassicRoom(survey._id)).emit('classic:closed', {
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
			status: normalizeSurveyStatus(survey.status),
			isClosed: true,
			ownerUserId: survey.userId,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions: finalTotalOpinions,
		});

		res.status(200).json({ message: 'Sondage clôturé avec succès' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Erreur serveur' });
	}
};
