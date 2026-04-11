/** @format */

const Survey = require('../models/Survey');
const OpinionFlash = require('../models/Opinion_Flash');
const User = require('../models/User');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');
const {
	buildAdminProfilesByUserId,
} = require('../utils/commentAnonymizer');
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
const {
	SURVEY_COMMENT_ERROR_CODES,
	isSurveyCommentModerationError,
	getOpinionDisplayPseudo,
	getOpinionVisibleReason,
	prepareOpinionsForSurveyView,
	prepareOpinionQueueItems,
	validateOpinionCommentModerationTarget,
	applyOpinionCommentDeletion,
	restoreOpinionComment,
	buildAutoModerationCommentFields,
	buildCommentSubmissionModerationPayload,
} = require('../services/surveyCommentModerationService');
const { moderateSurveyComment } = require('../services/contentModerationService');

const sanitizeSurveyForClient = (survey) => {
	const source = typeof survey?.toObject === 'function' ? survey.toObject() : { ...survey };
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
	};
};

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

async function buildBinaryCounts(surveyId, mode = 'clean') {
	const statusFilter = buildStatusFilter(mode);
	const [yes, no] = await Promise.all([
		OpinionFlash.countDocuments({ surveyId, answer: true, ...statusFilter }),
		OpinionFlash.countDocuments({ surveyId, answer: false, ...statusFilter }),
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

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		const canViewResults = hasParticipated || canManage;
		const canVote = !survey.isClosed && !hasParticipated;

		const payload = {
			survey: sanitizeSurveyForClient(survey),
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

		const fraudDecision = await evaluateFraudDecision({
			actionType: 'vote',
			userId: req.userId,
			surveyId: survey._id,
			surveyType: 'binary_flash',
			reason,
			identity: req.riskIdentity || {},
			turnstileToken: req.body.turnstileToken || null,
			challengeToken:
				req?.riskIdentity?.challengeToken ||
				String(req.headers?.['x-fraud-challenge-token'] || '').trim() ||
				null,
			opinionModel: 'Opinion_Flash',
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

		const commentModerationPromise =
			reason ?
				moderateSurveyComment({
					text: reason,
					locale: req.body.locale,
					surveyId: survey._id,
					surveyType: 'binary_flash',
					surveyModel: 'Opinion_Flash',
					userId: req.userId,
					userPseudoSnapshot: req.userPseudo,
				})
			:	Promise.resolve(null);

		const commentModerationResult = await commentModerationPromise;

		const opinion = new OpinionFlash({
			answer: req.body.answer,
			reason: reason || undefined,
			surveyId: survey._id,
			userId: req.userId,
			userPseudo: req.userPseudo,
			...buildOpinionFraudFields({
				result: fraudDecision,
				identity: req.riskIdentity || {},
			}),
			...(commentModerationResult ?
				buildAutoModerationCommentFields({
					decision: commentModerationResult.decision,
					logEntry: commentModerationResult.logEntry,
				})
			:	{}),
		});

		await opinion.save();
		res.status(201).json({
			message: 'Opinion enregistree !',
			hasParticipated: true,
			canVote: false,
			canViewResults: true,
			voteStatus: opinion.fraudStatus,
			fraudReview: opinion.fraudStatus === 'quarantined',
			commentModeration: buildCommentSubmissionModerationPayload(opinion),
		});

		const io = req.app.get('io');
		void (async () => {
			try {
				await trackVote({
					organizationId,
					idempotencyKey: `vote:${String(opinion._id)}`,
					meta: {
						surveyId: String(survey._id),
						type: 'binary',
						flash: true,
						userId: String(req.userId),
					},
				});

				const room = `flash-binary-${survey._id}`;
				const countsPayload = await buildBinaryCounts(survey._id);

				const visibleReason = String(getOpinionVisibleReason(opinion) || '').trim();
				if (visibleReason) {
					io.to(room).emit('flash:new-opinion', {
						_id: opinion._id,
						answer: opinion.answer,
						reason: visibleReason,
						surveyId: String(opinion.surveyId),
						userPseudo: getOpinionDisplayPseudo(opinion, survey._id),
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

				emitSurveyFeedUpdate(req.app.get('io'), {
					action: 'vote',
					surveyId: survey._id,
					type: 'binary',
					explain: survey.explain,
					status: normalizeSurveyStatus(survey.status),
					isClosed: Boolean(survey.isClosed),
					ownerUserId: survey.userId,
					organizationId: organizationId || survey.organizationId || null,
					createdAt: survey.createdAt,
					endedAt: survey.endedAt,
					totalOpinions: countsPayload.totalOpinions,
					occurredAt: new Date(),
				});
			} catch (postCommitError) {
				console.error('surveyFlash.submitOpinion.postCommit error:', postCommitError);
			}
		})();
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

		const allowAdminFilters = await canManageSurveyByOrganization(survey, req.userId);
		const canViewResults = hasParticipated || allowAdminFilters;
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

		const cleanFilter = buildStatusFilter('clean');
		const opinions = await OpinionFlash.find({
			surveyId: survey._id,
			...cleanFilter,
		})
			.sort({ createdAt: -1 })
			.lean();
		const integrity =
			allowAdminFilters ?
				await getIntegritySnapshotForSurvey(OpinionFlash, survey._id)
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
		const enrichedOpinions = prepareOpinionsForSurveyView(
			enrichedRawOpinions,
			survey._id,
			{
				includeAdminProfile: allowAdminFilters,
				includeVoterKey: allowAdminFilters,
				includeExportPseudo: allowAdminFilters,
				adminProfilesByUserId,
				requesterUserId: req.userId,
			},
		);

		const yes = enrichedOpinions.filter((op) => op.answer === true).length;
		const no = enrichedOpinions.length - yes;

		res.status(200).json({
			survey: sanitizeSurveyForClient(survey),
			type: 'binary',
			isClosed: Boolean(survey.isClosed),
			hasParticipated,
			canVote: !survey.isClosed && !hasParticipated,
			totalOpinions: enrichedOpinions.length,
			counts: { yes, no },
			meta: {
				demographicFiltersAvailable: allowAdminFilters,
				demographicFilterMode: 'age_gender',
			},
			integrity,
			opinions: enrichedOpinions,
		});
	} catch (error) {
		console.error('surveyFlash.getDetailedResults error:', error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getIntegrity = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id)
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

		const integrity = await getIntegritySnapshotForSurvey(OpinionFlash, survey._id);
		return res.status(200).json({
			surveyId: String(survey._id),
			type: 'binary',
			explain: false,
			...integrity,
		});
	} catch (error) {
		console.error('surveyFlash.getIntegrity error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.getQuarantineQueue = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id)
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
		const allowedStatuses = ['quarantined', 'confirmed_fraud', 'auto_moderated', 'all'];
		const selectedStatus = allowedStatuses.includes(statusFilterRaw) ?
				statusFilterRaw
			:	'quarantined';
		const queueQuery =
			selectedStatus === 'all' ?
				{
					$or: [
						{ fraudStatus: { $in: ['quarantined', 'confirmed_fraud'] } },
						{ commentDeletedAt: { $ne: null }, commentDeletedSource: 'auto' },
					],
				}
			: selectedStatus === 'auto_moderated' ?
				{ commentDeletedAt: { $ne: null }, commentDeletedSource: 'auto' }
			:	{ fraudStatus: selectedStatus };

		const [items, total] = await Promise.all([
			OpinionFlash.find({ surveyId: survey._id, ...queueQuery })
				.select(
					'_id answer reason userPseudo userId createdAt fraudStatus fraudScore fraudReasons challengeType commentDeletedAt commentDeletedSource commentModerationLogId commentModerationReasonCodes commentModerationSource commentModerationLocale',
				)
				.sort({ createdAt: -1 })
				.skip(skip)
				.limit(limit)
				.lean(),
			OpinionFlash.countDocuments({
				surveyId: survey._id,
				...queueQuery,
			}),
		]);

		const queueItems = prepareOpinionQueueItems(items, survey._id, {
			includeExportPseudo: true,
			includeModeratedReason:
				selectedStatus === 'auto_moderated' || selectedStatus === 'all',
		});
		const normalizedQueueItems = queueItems.map((item) => ({
			...item,
			queueKind:
				item?.commentModeration?.isDeleted &&
				item?.commentModeration?.deletedSource === 'auto' ?
					'auto_moderated'
				:	'fraud',
		}));

		return res.status(200).json({
			surveyId: String(survey._id),
			status: selectedStatus,
			total,
			page,
			limit,
			items: normalizedQueueItems,
		});
	} catch (error) {
		console.error('surveyFlash.getQuarantineQueue error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.restoreComment = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id)
			.select('userId organizationId')
			.lean();
		if (!survey) {
			return res.status(404).json({
				code: SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
				message: 'Sondage introuvable',
			});
		}

		const opinion = await OpinionFlash.findOne({
			_id: req.params.opinionId,
			surveyId: survey._id,
		});
		if (!opinion) {
			return res.status(404).json({
				code: SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
				message: 'Commentaire introuvable.',
			});
		}

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({
				code: SURVEY_COMMENT_ERROR_CODES.MODERATION_FORBIDDEN,
				message: "Vous devez etre owner ou admin de l'organisation pour moderer ce commentaire.",
			});
		}

		const restoration = await restoreOpinionComment({
			opinion,
			actorUserId: req.userId,
		});

		const io = req.app.get('io');
		const visibleReason = String(getOpinionVisibleReason(opinion) || '').trim();
		if (visibleReason) {
			io?.to(`flash-binary-${survey._id}`).emit('flash:comment-restored', {
				_id: String(opinion._id),
				answer: opinion.answer,
				reason: visibleReason,
				surveyId: String(opinion.surveyId),
				type: 'binary',
				userPseudo: getOpinionDisplayPseudo(opinion, survey._id),
				createdAt: opinion.createdAt,
				likeCount: Number(opinion.likes?.length || 0),
				dislikeCount: Number(opinion.dislikes?.length || 0),
				userLiked: false,
				userDisliked: false,
			});
		}

		return res.status(200).json({
			ok: true,
			surveyId: String(survey._id),
			type: 'binary',
			opinionId: String(opinion._id),
			restoredAt: restoration.restoredAt,
		});
	} catch (error) {
		if (isSurveyCommentModerationError(error)) {
			return res.status(error.status).json({
				code: error.code,
				message: error.message,
			});
		}
		console.error('surveyFlash.restoreComment error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.deleteComment = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id)
			.select('explain userId organizationId isClosed')
			.lean();
		if (!survey) {
			return res.status(404).json({
				code: SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
				message: 'Sondage introuvable',
			});
		}
		if (survey.explain !== false) {
			return res.status(400).json({
				code: SURVEY_COMMENT_ERROR_CODES.MODERATION_FORBIDDEN,
				message: "Ce sondage n'est pas un sondage Flash.",
			});
		}

		const opinion = await OpinionFlash.findOne({
			_id: req.params.opinionId,
			surveyId: survey._id,
		});
		if (!opinion) {
			return res.status(404).json({
				code: SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
				message: 'Commentaire introuvable.',
			});
		}

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		validateOpinionCommentModerationTarget({
			survey,
			opinion,
			actorUserId: req.userId,
			canModerate: canManage,
		});

		const deletion = await applyOpinionCommentDeletion({
			opinion,
			actorUserId: req.userId,
		});

		const io = req.app.get('io');
		io?.to(`flash-binary-${survey._id}`).emit('flash:comment-deleted', {
			surveyId: String(survey._id),
			type: 'binary',
			opinionId: String(opinion._id),
			deletedAt: deletion.deletedAt,
		});

		return res.status(200).json({
			ok: true,
			surveyId: String(survey._id),
			type: 'binary',
			opinionId: String(opinion._id),
			deletedAt: deletion.deletedAt,
		});
	} catch (error) {
		if (isSurveyCommentModerationError(error)) {
			return res.status(error.status).json({
				code: error.code,
				message: error.message,
			});
		}
		console.error('surveyFlash.deleteComment error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.reviewQuarantineOpinion = async (req, res) => {
	try {
		const action = String(req.body?.action || '').trim().toLowerCase();
		if (!['release', 'confirm_fraud'].includes(action)) {
			return res.status(400).json({ message: 'Action invalide.' });
		}

		const survey = await Survey.findById(req.params.id)
			.select('explain userId organizationId isClosed status createdAt endedAt')
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

		const opinion = await OpinionFlash.findOne({
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
			surveyType: 'binary_flash',
			opinionModel: OpinionFlash.modelName,
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

		const countsPayload = await buildBinaryCounts(survey._id, 'clean');
		const io = req.app.get('io');
		io.to(`flash-binary-${survey._id}`).emit('flash:counts', {
			surveyId: String(survey._id),
			type: 'binary',
			totalOpinions: countsPayload.totalOpinions,
			counts: countsPayload.counts,
			isClosed: Boolean(survey.isClosed),
		});

		const organizationId = await resolveSurveyOrganizationId(survey);
		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'vote',
			surveyId: survey._id,
			type: 'binary',
			explain: survey.explain,
			status: normalizeSurveyStatus(survey.status),
			isClosed: Boolean(survey.isClosed),
			ownerUserId: survey.userId,
			organizationId: organizationId || survey.organizationId || null,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions: countsPayload.totalOpinions,
			occurredAt: new Date(),
		});

		const integrity = await getIntegritySnapshotForSurvey(OpinionFlash, survey._id);
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
		console.error('surveyFlash.reviewQuarantineOpinion error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};



