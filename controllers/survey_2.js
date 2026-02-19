/** @format */

const mongoose = require('mongoose');

const Opinion_2 = require('../models/Opinion_2');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const Survey_2 = require('../models/Survey_2');
const User = require('../models/User');
const { normalizeQuestion } = require('../utils/questionNormalizer');
const {
	buildAdminProfilesByUserId,
	anonymizeOpinionsForSurvey,
} = require('../utils/commentAnonymizer');
const {
	extractIncomingOptions,
	resolveSurveyOptions,
	validateOptions,
	normalizeValidatedOptions,
	buildSurveyOptionPayload,
	buildLegacyOptionFields,
	buildLabelsMapFromOptions,
	buildOptionKeys,
	isChoiceAllowed,
	buildCountsMapFromOpinions,
	aggregateCountsByOptionKeys,
} = require('../utils/multipleSurveyOptions');
const {
	broadcastSurveyNewPush,
	broadcastSurveyClosedPush,
} = require('../services/supportPushService');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');

const parseExplainFlag = (value) => {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
	if (typeof value === 'number') return value !== 0;
	return true;
};

const toObjectId = (id) => new mongoose.Types.ObjectId(String(id));

const getMultipleOpinionModel = (survey) =>
	survey && survey.explain === false ? Opinion2Flash : Opinion_2;

const canManageSurvey = (survey, req) =>
	req.userRole === 'admin' || String(survey?.userId) === String(req.userId);

const normalizeSurveyForResponse = (survey) => {
	const source = typeof survey?.toObject === 'function' ? survey.toObject() : { ...survey };
	const optionPayload = buildSurveyOptionPayload(source);

	return {
		...source,
		options: optionPayload.options,
		optionKeys: optionPayload.optionKeys,
		labels: optionPayload.labels,
		...optionPayload.legacyFields,
	};
};

const syncCanonicalOptionsOnDocument = (surveyDocument) => {
	const options = resolveSurveyOptions(surveyDocument);
	if (!options.length) return options;

	surveyDocument.options = options;
	Object.assign(surveyDocument, buildLegacyOptionFields(options));
	return options;
};

exports.createSurvey = async (req, res) => {
	try {
		delete req.body._id;

		const theme = String(req.body.theme || '').trim();
		const realTheme =
			'#' +
			theme
				.split(' ')
				.filter(Boolean)
				.map(
					(word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
				)
				.join('');

		const requestedOptions = extractIncomingOptions(req.body);
		const optionsValidation = validateOptions(requestedOptions);
		if (!optionsValidation.valid) {
			return res.status(400).json({
				code: optionsValidation.code,
				message: optionsValidation.message,
			});
		}
		const options = normalizeValidatedOptions(requestedOptions);

		const survey = new Survey_2({
			theme: realTheme,
			contexte: req.body.contexte,
			question: normalizeQuestion(req.body.question),
			explain: parseExplainFlag(req.body.explain),
			options,
			...buildLegacyOptionFields(options),
			userId: req.userId,
		});

		const savedSurvey = await survey.save();
		const normalizedSurvey = normalizeSurveyForResponse(savedSurvey);

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

		return res.status(200).json({
			message: 'Survey saved!',
			surveyId: savedSurvey._id,
			explain: savedSurvey.explain,
			options: normalizedSurvey.options,
		});
	} catch (error) {
		if (error && error.code === 11000) {
			return res.status(400).json({ message: 'Un sondage avec ce theme existe deja.' });
		}
		console.error(error);
		return res.status(400).json({ error });
	}
};

exports.getOneSurvey = async (req, res) => {
	try {
		const id = req.params.id;
		if (!mongoose.Types.ObjectId.isValid(id)) {
			return res.status(400).json({ message: 'ID invalide' });
		}

		const survey = await Survey_2.findById(id).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		return res.status(200).json(normalizeSurveyForResponse(survey));
	} catch (error) {
		return res.status(500).json({ error });
	}
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
				message: 'Ce sondage est en mode Flash. Utilisez les endpoints Flash dedies.',
			});
		}

		if (survey.isClosed) {
			return res.status(403).json({
				message: 'Le sondage est cloture, vous ne pouvez plus y repondre.',
			});
		}

		const options = resolveSurveyOptions(survey);
		if (!isChoiceAllowed(req.body.choice, options)) {
			return res.status(400).json({ message: 'Reponse invalide' });
		}

		const existingOpinion = await Opinion_2.findOne({
			surveyId: toObjectId(surveyId),
			userId: req.userId,
		});

		if (existingOpinion) {
			return res.status(403).json({
				message:
					'Vous avez deja repondu a ce sondage, merci de patienter la publication des resultats.',
			});
		}

		if (!req.body.reason || String(req.body.reason).trim() === '') {
			return res.status(400).json({ message: 'La raison est obligatoire.' });
		}

		const opinion = new Opinion_2({
			answer: String(req.body.choice).trim(),
			reason: req.body.reason,
			surveyId: toObjectId(surveyId),
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		await opinion.save();

		const totalOpinions = await Opinion_2.countDocuments({ surveyId: survey._id });

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'vote',
			surveyId: survey._id,
			type: 'multiple',
			explain: survey.explain,
			isClosed: Boolean(survey.isClosed),
			ownerUserId: survey.userId,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions,
			occurredAt: new Date(),
		});
		return res.status(201).json({ message: 'Opinion enregistree !' });
	} catch (error) {
		if (error?.code === 11000) {
			return res.status(403).json({ message: 'Vous avez deja repondu a ce sondage.' });
		}
		console.error('ERREUR dans submitOpinion:', error);
		return res.status(500).json({ error: error.message });
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
		return res.status(200).json({ totalOpinions });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ message: 'Erreur stats sondage multiple' });
	}
};

exports.closeSurvey = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id);

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (String(survey.userId) !== String(req.userId)) {
			return res.status(403).json({ message: 'Non autorise' });
		}

		if (survey.isClosed) {
			return res.status(400).json({ message: 'Ce sondage est deja cloture.' });
		}

		const options = syncCanonicalOptionsOnDocument(survey);
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

		let finalTotalOpinions = null;

		if (survey.explain === false) {
			const io = req.app.get('io');
			const room = `flash-multiple-${survey._id}`;
			const optionKeys = buildOptionKeys(options);
			const labels = buildLabelsMapFromOptions(options);
			const { counts, totalOpinions } = await aggregateCountsByOptionKeys(
				Opinion2Flash,
				survey._id,
				optionKeys,
			);
			finalTotalOpinions = totalOpinions;

			io.to(room).emit('flash:counts', {
				surveyId: String(survey._id),
				type: 'multiple',
				options,
				optionKeys,
				labels,
				counts,
				totalOpinions,
				isClosed: true,
			});

			io.to(room).emit('flash:closed', {
				surveyId: String(survey._id),
				type: 'multiple',
				endedAt: survey.endedAt,
			});
		} else {
			finalTotalOpinions = await Opinion_2.countDocuments({ surveyId: survey._id });
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
			totalOpinions: finalTotalOpinions,
		});

		return res.status(200).json({ message: 'Sondage cloture avec succes.' });
	} catch (error) {
		console.error(error);
		return res.status(500).json({ message: 'Erreur serveur' });
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
				message: "Le sondage n'est pas encore cloture. Resultats indisponibles",
			});
		}

		const optionPayload = buildSurveyOptionPayload(survey);
		const OpinionModel = getMultipleOpinionModel(survey);
		const opinions = await OpinionModel.find({ surveyId }).lean();
		const counts = buildCountsMapFromOpinions(opinions, optionPayload.optionKeys);
		const allowAdminFilters = canManageSurvey(survey, req);
		let adminProfilesByUserId = null;

		if (allowAdminFilters) {
			const opinionUserIds = [
				...new Set(opinions.map((opinion) => String(opinion?.userId || '')).filter(Boolean)),
			];
			const users =
				opinionUserIds.length > 0 ?
					await User.find({ _id: { $in: opinionUserIds } })
						.select('birthdate gender')
						.lean()
				:	[];
			adminProfilesByUserId = buildAdminProfilesByUserId(users);
		}

		const enrichedRawOpinions = opinions.map((opinion) => {
			const likeCount = (opinion.likes && opinion.likes.length) || 0;
			const dislikeCount = (opinion.dislikes && opinion.dislikes.length) || 0;
			const userLiked = req.userId
				? (opinion.likes || []).some((id) => String(id) === String(req.userId))
				: false;
			const userDisliked = req.userId
				? (opinion.dislikes || []).some((id) => String(id) === String(req.userId))
				: false;

			return {
				...opinion,
				likeCount,
				dislikeCount,
				userLiked,
				userDisliked,
			};
		});
		const enrichedOpinions = anonymizeOpinionsForSurvey(enrichedRawOpinions, surveyId, {
			includeAdminProfile: allowAdminFilters,
			includeVoterKey: allowAdminFilters,
			adminProfilesByUserId,
			requesterUserId: req.userId,
		});

		return res.status(200).json({
			totalOpinions: opinions.length,
			options: optionPayload.options,
			optionKeys: optionPayload.optionKeys,
			labels: optionPayload.labels,
			counts,
			meta: {
				demographicFiltersAvailable: allowAdminFilters,
				demographicFilterMode: 'age_gender',
			},
			...optionPayload.legacyFields,
			opinions: enrichedOpinions,
		});
	} catch (error) {
		console.error(error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};
