/** @format */

const Survey_2 = require('../models/Survey_2');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const User = require('../models/User');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');
const {
	buildSurveyAlias,
	buildAdminProfilesByUserId,
	anonymizeOpinionsForSurvey,
} = require('../utils/commentAnonymizer');
const {
	buildSurveyOptionPayload,
	resolveSurveyOptions,
	isChoiceAllowed,
	buildCountsMapFromOpinions,
	aggregateCountsByOptionKeys,
	buildLegacyOptionFields,
} = require('../utils/multipleSurveyOptions');
const { normalizeSurveyStatus } = require('../utils/surveyStatus');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { trackVote } = require('../services/billing/usageService');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { canManageSurveyByOrganization } = require('../services/surveyAuthorizationService');

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

const normalizeSurveyForPayload = (survey) => {
	const source = typeof survey?.toObject === 'function' ? survey.toObject() : { ...survey };
	const optionPayload = buildSurveyOptionPayload(source);

	return {
		_id: source?._id,
		theme: source?.theme,
		question: source?.question,
		contexte: source?.contexte,
		explain: source?.explain,
		status: normalizeSurveyStatus(source?.status),
		isClosed: Boolean(source?.isClosed),
		createdAt: source?.createdAt,
		endedAt: source?.endedAt || null,
		options: optionPayload.options,
		optionKeys: optionPayload.optionKeys,
		labels: optionPayload.labels,
		...optionPayload.legacyFields,
	};
};

exports.getState = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const hasParticipated = Boolean(
			await Opinion2Flash.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		const canViewResults = hasParticipated || canManage;
		const canVote = !survey.isClosed && !hasParticipated;
		const normalizedSurvey = normalizeSurveyForPayload(survey);

		const payload = {
			survey: normalizedSurvey,
			type: 'multiple',
			options: normalizedSurvey.options,
			optionKeys: normalizedSurvey.optionKeys,
			labels: normalizedSurvey.labels,
			hasParticipated,
			canVote,
			canViewResults,
			isClosed: Boolean(survey.isClosed),
		};

		if (survey.isClosed && !canViewResults) {
			payload.message = 'Ce sondage est cloture. Les resultats sont reserves aux votants.';
		}

		return res.status(200).json(payload);
	} catch (error) {
		console.error('surveyFlash_2.getState error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.submitOpinion = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id);
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		if (survey.isClosed) {
			return res.status(403).json({
				message: 'Le sondage est cloture, vous ne pouvez plus y repondre.',
			});
		}
		const organizationId = await resolveSurveyOrganizationId(survey);
		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.VOTE,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}

		const options = resolveSurveyOptions(survey);
		if (!isChoiceAllowed(req.body.choice, options)) {
			return res.status(400).json({ message: 'Reponse invalide' });
		}

		const already = await Opinion2Flash.findOne({
			surveyId: survey._id,
			userId: req.userId,
		})
			.select('_id')
			.lean();

		if (already) {
			return res.status(403).json({
				message:
					'Vous avez deja repondu a ce sondage, merci de patienter la publication des resultats.',
			});
		}

		const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';

		const opinion = new Opinion2Flash({
			answer: String(req.body.choice).trim(),
			reason: reason || undefined,
			surveyId: survey._id,
			userId: req.userId,
			userPseudo: req.userPseudo,
		});

		await opinion.save();
		await trackVote({
			organizationId,
			idempotencyKey: `vote:${String(opinion._id)}`,
			meta: {
				surveyId: String(survey._id),
				type: 'multiple',
				flash: true,
				userId: String(req.userId),
			},
		});

		const io = req.app.get('io');
		const room = `flash-multiple-${survey._id}`;
		const normalizedSurvey = normalizeSurveyForPayload(survey);
		const { counts, totalOpinions } = await aggregateCountsByOptionKeys(
			Opinion2Flash,
			survey._id,
			normalizedSurvey.optionKeys,
		);

		if (reason) {
			io.to(room).emit('flash:new-opinion', {
				_id: opinion._id,
				answer: opinion.answer,
				reason: opinion.reason || '',
				surveyId: String(opinion.surveyId),
				userPseudo: buildSurveyAlias(survey._id, opinion.userId),
				createdAt: opinion.createdAt,
				likeCount: 0,
				dislikeCount: 0,
				userLiked: false,
				userDisliked: false,
			});
		}

		io.to(room).emit('flash:counts', {
			surveyId: String(survey._id),
			type: 'multiple',
			options: normalizedSurvey.options,
			optionKeys: normalizedSurvey.optionKeys,
			labels: normalizedSurvey.labels,
			counts,
			totalOpinions,
			isClosed: Boolean(survey.isClosed),
		});

		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'vote',
			surveyId: survey._id,
			type: 'multiple',
			explain: survey.explain,
			status: normalizeSurveyStatus(survey.status),
			isClosed: Boolean(survey.isClosed),
			ownerUserId: survey.userId,
			organizationId: organizationId || survey.organizationId || null,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions,
			occurredAt: new Date(),
		});

		return res.status(201).json({
			message: 'Opinion enregistree !',
			hasParticipated: true,
			canVote: false,
		});
	} catch (error) {
		if (error && error.code === 11000) {
			return res.status(403).json({
				message:
					'Vous avez deja repondu a ce sondage, merci de patienter la publication des resultats.',
			});
		}
		console.error('surveyFlash_2.submitOpinion error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getDetailedResults = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id).lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const hasParticipated = Boolean(
			await Opinion2Flash.findOne({
				surveyId: survey._id,
				userId: req.userId,
			})
				.select('_id')
				.lean(),
		);

		const allowAdminFilters = await canManageSurveyByOrganization(survey, req.userId);
		const canViewResults = hasParticipated || allowAdminFilters;
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

		const normalizedSurvey = normalizeSurveyForPayload(survey);
		const opinions = await Opinion2Flash.find({ surveyId: survey._id })
			.sort({ createdAt: -1 })
			.lean();
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

		const enrichedRawOpinions = opinions.map((opinion) =>
			formatOpinion(opinion, req.userId),
		);
		const enrichedOpinions = anonymizeOpinionsForSurvey(
			enrichedRawOpinions,
			survey._id,
			{
				includeAdminProfile: allowAdminFilters,
				includeVoterKey: allowAdminFilters,
				adminProfilesByUserId,
				requesterUserId: req.userId,
			},
		);
		const counts = buildCountsMapFromOpinions(
			enrichedOpinions,
			normalizedSurvey.optionKeys,
		);

		return res.status(200).json({
			survey: normalizedSurvey,
			type: 'multiple',
			isClosed: Boolean(survey.isClosed),
			hasParticipated,
			canVote: !survey.isClosed && !hasParticipated,
			totalOpinions: enrichedOpinions.length,
			options: normalizedSurvey.options,
			optionKeys: normalizedSurvey.optionKeys,
			labels: normalizedSurvey.labels,
			counts,
			meta: {
				demographicFiltersAvailable: allowAdminFilters,
				demographicFilterMode: 'age_gender',
			},
			...buildLegacyOptionFields(normalizedSurvey.options),
			opinions: enrichedOpinions,
		});
	} catch (error) {
		console.error('surveyFlash_2.getDetailedResults error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};


