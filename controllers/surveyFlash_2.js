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
const {
	evaluateFraudDecision,
	buildOpinionFraudFields,
} = require('../services/fraud/fraudDecisionService');
const { logFraudDecision } = require('../services/fraud/fraudDecisionLogService');
const {
	buildStatusFilter,
	getIntegritySnapshotForSurvey,
} = require('../services/fraud/opinionFilterService');

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

		const fraudDecision = await evaluateFraudDecision({
			actionType: 'vote',
			userId: req.userId,
			surveyId: survey._id,
			surveyType: 'multiple_flash',
			reason,
			identity: req.riskIdentity || {},
			turnstileToken: req.body.turnstileToken || null,
			challengeToken:
				req?.riskIdentity?.challengeToken ||
				String(req.headers?.['x-fraud-challenge-token'] || '').trim() ||
				null,
			opinionModel: 'Opinion_2_Flash',
		});

		if (fraudDecision.kind === 'challenge') {
			return res.status(fraudDecision.httpStatus || 428).json({
				code: fraudDecision.code,
				message: fraudDecision.message,
				challengeType: fraudDecision.challengeType,
				challenge:
					fraudDecision.challenge || {
						type: fraudDecision.challengeType,
						turnstile: fraudDecision.turnstile || null,
						otp: fraudDecision.otp || null,
					},
				otp: fraudDecision.otp || null,
			});
		}

		if (fraudDecision.decision === 'blocked') {
			return res.status(fraudDecision.httpStatus || 403).json({
				code: fraudDecision.code || 'FRAUD_BLOCKED',
				message: fraudDecision.message || 'Vote bloque pour risque eleve.',
			});
		}

		const opinion = new Opinion2Flash({
			answer: String(req.body.choice).trim(),
			reason: reason || undefined,
			surveyId: survey._id,
			userId: req.userId,
			userPseudo: req.userPseudo,
			...buildOpinionFraudFields({
				result: fraudDecision,
				identity: req.riskIdentity || {},
			}),
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
			buildStatusFilter('clean'),
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
			canViewResults: true,
			voteStatus: opinion.fraudStatus,
			fraudReview: opinion.fraudStatus === 'quarantined',
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
		const cleanFilter = buildStatusFilter('clean');
		const opinions = await Opinion2Flash.find({
			surveyId: survey._id,
			...cleanFilter,
		})
			.sort({ createdAt: -1 })
			.lean();
		const integrity =
			allowAdminFilters ?
				await getIntegritySnapshotForSurvey(Opinion2Flash, survey._id)
			:	null;
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
			integrity,
			...buildLegacyOptionFields(normalizedSurvey.options),
			opinions: enrichedOpinions,
		});
	} catch (error) {
		console.error('surveyFlash_2.getDetailedResults error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getIntegrity = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id)
			.select('explain userId organizationId')
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}
		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Acces admin requis.' });
		}

		const integrity = await getIntegritySnapshotForSurvey(Opinion2Flash, survey._id);
		return res.status(200).json({
			surveyId: String(survey._id),
			type: 'multiple',
			explain: false,
			...integrity,
		});
	} catch (error) {
		console.error('surveyFlash_2.getIntegrity error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getQuarantineQueue = async (req, res) => {
	try {
		const survey = await Survey_2.findById(req.params.id)
			.select('explain userId organizationId')
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}
		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Acces admin requis.' });
		}

		const limit = Math.min(
			100,
			Math.max(1, Number.parseInt(req.query?.limit || '50', 10)),
		);
		const page = Math.max(1, Number.parseInt(req.query?.page || '1', 10));
		const skip = (page - 1) * limit;
		const statusFilterRaw = String(req.query?.status || '').trim().toLowerCase();
		const allowedStatuses = ['quarantined', 'confirmed_fraud', 'all'];
		const selectedStatus = allowedStatuses.includes(statusFilterRaw) ?
				statusFilterRaw
			:	'quarantined';
		const queueStatusFilter =
			selectedStatus === 'all' ?
				{ $in: ['quarantined', 'confirmed_fraud'] }
			:	selectedStatus;

		const [items, total] = await Promise.all([
			Opinion2Flash.find({ surveyId: survey._id, fraudStatus: queueStatusFilter })
				.select(
					'_id answer reason userPseudo userId createdAt fraudStatus fraudScore fraudReasons challengeType',
				)
				.sort({ createdAt: -1 })
				.skip(skip)
				.limit(limit)
				.lean(),
			Opinion2Flash.countDocuments({
				surveyId: survey._id,
				fraudStatus: queueStatusFilter,
			}),
		]);

		return res.status(200).json({
			surveyId: String(survey._id),
			status: selectedStatus,
			total,
			page,
			limit,
			items,
		});
	} catch (error) {
		console.error('surveyFlash_2.getQuarantineQueue error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.reviewQuarantineOpinion = async (req, res) => {
	try {
		const action = String(req.body?.action || '').trim().toLowerCase();
		if (!['release', 'confirm_fraud'].includes(action)) {
			return res.status(400).json({ message: 'Action invalide.' });
		}

		const survey = await Survey_2.findById(req.params.id)
			.select(
				'explain userId organizationId isClosed status createdAt endedAt options reponse_1 reponse_2 reponse_3 reponse_4 reponse_5 reponse_6',
			)
			.lean();
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}
		if (survey.explain !== false) {
			return res.status(400).json({ message: "Ce sondage n'est pas un sondage Flash." });
		}

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Acces admin requis.' });
		}

		const opinion = await Opinion2Flash.findOne({
			_id: req.params.opinionId,
			surveyId: survey._id,
		});
		if (!opinion) {
			return res.status(404).json({ message: 'Opinion introuvable.' });
		}

		if (action === 'release') {
			opinion.fraudStatus = 'released';
			opinion.fraudReasons = [
				...new Set([...(opinion.fraudReasons || []), 'ADMIN_RELEASED']),
			];
		} else {
			opinion.fraudStatus = 'confirmed_fraud';
			opinion.fraudReasons = [
				...new Set([...(opinion.fraudReasons || []), 'ADMIN_CONFIRMED_FRAUD']),
			];
		}
		opinion.reviewedBy = req.userId;
		opinion.reviewedAt = new Date();
		await opinion.save();
		await logFraudDecision({
			event: 'quarantine_review',
			decision: action === 'release' ? 'released' : 'confirmed_fraud',
			actionType: 'review',
			userId: req.userId,
			surveyId: survey._id,
			surveyType: 'multiple_flash',
			opinionModel: Opinion2Flash.modelName,
			ipHash: opinion.ipHash || null,
			deviceHash: opinion.deviceHash || null,
			riskScore: Number(opinion.fraudScore || 0),
			reasons: [...new Set([...(opinion.fraudReasons || []), 'ADMIN_REVIEW'])],
			challengeType: String(opinion.challengeType || 'none'),
			meta: {
				action,
				opinionId: String(opinion._id),
				reviewedStatus: opinion.fraudStatus,
			},
		});

		const io = req.app.get('io');
		const normalizedSurvey = normalizeSurveyForPayload(survey);
		const { counts, totalOpinions } = await aggregateCountsByOptionKeys(
			Opinion2Flash,
			survey._id,
			normalizedSurvey.optionKeys,
			buildStatusFilter('clean'),
		);
		io.to(`flash-multiple-${survey._id}`).emit('flash:counts', {
			surveyId: String(survey._id),
			type: 'multiple',
			options: normalizedSurvey.options,
			optionKeys: normalizedSurvey.optionKeys,
			labels: normalizedSurvey.labels,
			counts,
			totalOpinions,
			isClosed: Boolean(survey.isClosed),
		});

		const organizationId = await resolveSurveyOrganizationId(survey);
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

		const integrity = await getIntegritySnapshotForSurvey(Opinion2Flash, survey._id);
		return res.status(200).json({
			message:
				action === 'release' ?
					'Opinion liberee et reintegree.'
				:	'Opinion confirmee comme fraude.',
			opinionId: String(opinion._id),
			status: opinion.fraudStatus,
			integrity,
		});
	} catch (error) {
		console.error('surveyFlash_2.reviewQuarantineOpinion error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};



