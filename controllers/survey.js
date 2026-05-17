/** @format */

const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Opinion = require('../models/Opinion');
const OpinionFlash = require('../models/Opinion_Flash');
const User = require('../models/User');
const { normalizeQuestion } = require('../utils/questionNormalizer');
const {
	buildAdminProfilesByUserId,
} = require('../utils/commentAnonymizer');
const {
	broadcastSurveyNewPush,
	broadcastSurveyClosedPush,
} = require('../services/supportPushService');
const { emitSurveyFeedUpdate } = require('../sockets/surveyFeedHandlers');
const { normalizeSurveyStatus } = require('../utils/surveyStatus');
const {
	resolveActiveOrganizationContext,
} = require('../services/organizationService');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { trackSurveyCreated, trackVote } = require('../services/billing/usageService');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { canManageSurveyByOrganization } = require('../services/surveyAuthorizationService');
const {
	evaluateFraudDecision,
	buildOpinionFraudFields,
} = require('../services/fraud/fraudDecisionService');
const {
	reserveDeviceVote,
	commitDeviceVoteLocks,
	commitDeviceTrace,
	releaseDeviceVoteLocks,
	applyMachineDecisionToFraudDecision,
} = require('../services/fraud/deviceIntegrityService');
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
const {
	refreshAndEmitBroadcastSnapshot,
	emitBroadcastStatus,
} = require('../services/broadcastRealtimeService');
const {
	publishSurveyCommentToChat,
} = require('../services/surveyCommentChatBridge');

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
const getClassicRoom = (surveyId) => `classic-binary-${String(surveyId)}`;

async function getBinaryCounts(surveyId, OpinionModel, mode = 'clean') {
	const statusFilter = buildStatusFilter(mode);
	const [yesCount, noCount] = await Promise.all([
		OpinionModel.countDocuments({ surveyId, answer: true, ...statusFilter }),
		OpinionModel.countDocuments({ surveyId, answer: false, ...statusFilter }),
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

const emitClassicBinaryOpinion = (
	io,
	survey,
	opinion,
	eventName = 'classic:new-opinion',
) => {
	const reason = String(getOpinionVisibleReason(opinion) || '').trim();
	if (!io || !survey || !opinion || !reason) return;

	io.to(getClassicRoom(survey._id)).emit(eventName, {
		_id: String(opinion._id),
		answer: Boolean(opinion.answer),
		reason,
		surveyId: String(opinion.surveyId),
		type: 'binary',
		userPseudo: getOpinionDisplayPseudo(opinion, survey._id),
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
		const organizationContext = await resolveActiveOrganizationContext({
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
			requestedOrganizationId:
				req.headers['x-organization-id'] ||
				req.headers['x-org-id'] ||
				req.body?.organizationId,
		});
		if (!organizationContext.ok) {
			return res.status(403).json({
				code: organizationContext.code,
				message: "Organisation active introuvable pour la création du sondage.",
			});
		}

		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.CREATE_SURVEY,
			organizationId: organizationContext.organization._id,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
			role: organizationContext.role,
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}

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
			organizationId: organizationContext.organization._id,
		});

		const savedSurvey = await survey.save();
		await trackSurveyCreated({
			organizationId: savedSurvey.organizationId,
			idempotencyKey: `survey-create:${String(savedSurvey._id)}`,
			meta: {
				surveyId: String(savedSurvey._id),
				type: 'binary',
				userId: String(req.userId),
			},
		});

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
			organizationId: savedSurvey.organizationId || null,
			creatorName: req.userPseudo || 'Administrateur',
			createdAt: savedSurvey.createdAt,
			endedAt: savedSurvey.endedAt,
		});

		res.status(200).json({
			message: 'Sondage enregistré !',
			surveyId: savedSurvey._id,
			explain: savedSurvey.explain,
			status: normalizeSurveyStatus(savedSurvey.status),
		});
	} catch (error) {
		if (error && error.code === 11000) {
			return res.status(400).json({
				message:
					'Conflit de donnees detecte lors de l enregistrement du sondage.',
			});
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
		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		const canVote = !survey.isClosed && !hasParticipated;
		const canViewResults = hasParticipated || canManage;
		let message = '';

		if (!canViewResults) {
			message = survey.isClosed ?
				'Ce sondage est clôturé. Les résultats sont réservés aux votants.'
			:	'Votez pour accéder aux résultats en temps réel.';
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
	let deviceVoteReservation = null;
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
		const OpinionModel = getBinaryOpinionModel(survey);
		const existingOpinion = await OpinionModel.findOne({
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

		const normalizedReason = String(req.body.reason || '').trim();
		const commentRequired = survey.explain !== false;
		if (commentRequired && !normalizedReason) {
			return res.status(400).json({ message: 'La raison est obligatoire.' });
		}

		const fraudDecision = await evaluateFraudDecision({
			actionType: 'vote',
			userId: req.userId,
			surveyId: survey._id,
			surveyType: 'binary',
			reason: normalizedReason,
			identity: req.riskIdentity || {},
			turnstileToken: req.body.turnstileToken || null,
			challengeToken:
				req?.riskIdentity?.challengeToken ||
				String(req.headers?.['x-fraud-challenge-token'] || '').trim() ||
				null,
			opinionModel: OpinionModel.modelName || 'Opinion',
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
				message: fraudDecision.message || 'Vote bloqué pour risque élevé.',
			});
		}

		deviceVoteReservation = await reserveDeviceVote({
			req,
			userId: req.userId,
			surveyId: survey._id,
			surveyType: 'binary',
			fraudDecision,
		});
		if (!deviceVoteReservation.ok) {
			return res.status(deviceVoteReservation.httpStatus || 403).json({
				code: deviceVoteReservation.code,
				message: deviceVoteReservation.message,
			});
		}
		applyMachineDecisionToFraudDecision({
			fraudDecision,
			machineDecision: deviceVoteReservation.machineDecision,
		});

		const commentModerationResult =
			normalizedReason ?
				await moderateSurveyComment({
					text: normalizedReason,
					locale: req.body.locale,
					surveyId: survey._id,
					surveyType: 'binary',
					surveyModel: OpinionModel.modelName || 'Opinion',
					userId: req.userId,
					userPseudoSnapshot: req.userPseudo,
				})
			:	null;

		const opinion = new OpinionModel({
			answer: req.body.answer,
			reason: normalizedReason || undefined,
			surveyId: toObjectId(surveyId),
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
		await commitDeviceVoteLocks({
			reservation: deviceVoteReservation,
			opinionId: opinion._id,
		});
		await commitDeviceTrace({
			reservation: deviceVoteReservation,
			opinionId: opinion._id,
			fraudStatus: opinion.fraudStatus,
		});
		res.status(201).json({
			message: 'Opinion enregistrée !',
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
						userId: String(req.userId),
					},
				});

				const counts = await getBinaryCounts(survey._id, OpinionModel);
				emitClassicBinaryOpinion(io, survey, opinion);
				const visibleReason = String(getOpinionVisibleReason(opinion) || '').trim();
				if (visibleReason) {
					await publishSurveyCommentToChat({
						io,
						surveyId: survey._id,
						surveyModel: 'Survey',
						userId: req.userId,
						userPseudo: req.userPseudo,
						userPicture: req.user?.picture || null,
						message: visibleReason,
					});
				}
				emitClassicBinaryCounts(io, survey, counts, survey.isClosed);

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
					totalOpinions: counts.totalOpinions,
					occurredAt: new Date(),
				});
				await refreshAndEmitBroadcastSnapshot({
					io,
					surveyId: survey._id,
					reason: 'survey-vote',
				});
			} catch (postCommitError) {
				console.error('submitOpinion.postCommit error:', postCommitError);
			}
		})();
	} catch (err) {
		await releaseDeviceVoteLocks({
			lockIds: deviceVoteReservation?.createdLockIds || [],
			userId: req.userId,
		});
		if (err && err.code === 11000) {
			return res.status(403).json({
				message:
					'Vous avez déjà répondu à ce sondage, merci de patienter la publication des résultats.',
			});
		}
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
		const totalOpinions = await OpinionModel.countDocuments({
			surveyId,
			...buildStatusFilter('clean'),
		});

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
		const allowAdminFilters = await canManageSurveyByOrganization(survey, req.userId);
		const canViewResults = hasParticipated || allowAdminFilters;
		const canVote = !survey.isClosed && !hasParticipated;
		if (!canViewResults) {
			if (survey.isClosed) {
				return res.status(403).json({
					message: 'Ce sondage est clôturé. Les résultats sont réservés aux votants.',
				});
			}
			return res.status(403).json({
				message: 'Votez pour accéder aux résultats en temps réel.',
			});
		}

		const cleanFilter = buildStatusFilter('clean');
		const results = await OpinionModel.find({ surveyId, ...cleanFilter }).lean();
		const integrity =
			allowAdminFilters ?
				await getIntegritySnapshotForSurvey(OpinionModel, survey._id)
			:	null;
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
		const enriched = prepareOpinionsForSurveyView(enrichedRaw, surveyId, {
			includeAdminProfile: allowAdminFilters,
			includeVoterKey: allowAdminFilters,
			includeExportPseudo: allowAdminFilters,
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
			integrity,
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
			return res.status(400).json({ message: 'Le sondage est déjà clôturé....' });
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

		const surveyOrganizationId = await resolveSurveyOrganizationId(survey);
		emitSurveyFeedUpdate(req.app.get('io'), {
			action: 'closed',
			surveyId: survey._id,
			type: 'binary',
			explain: survey.explain,
			status: normalizeSurveyStatus(survey.status),
			isClosed: true,
			ownerUserId: survey.userId,
			organizationId: surveyOrganizationId || survey.organizationId || null,
			createdAt: survey.createdAt,
			endedAt: survey.endedAt,
			totalOpinions: finalTotalOpinions,
		});
		await refreshAndEmitBroadcastSnapshot({
			io: req.app.get('io'),
			surveyId: survey._id,
			reason: 'survey-closed',
		});

		res.status(200).json({ message: 'Sondage clôturé avec succès....' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Erreur serveur' });
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

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès admin requis.' });
		}

		const OpinionModel = getBinaryOpinionModel(survey);
		const integrity = await getIntegritySnapshotForSurvey(
			OpinionModel,
			survey._id,
		);

		return res.status(200).json({
			surveyId: String(survey._id),
			type: 'binary',
			explain: survey.explain === false ? false : true,
			...integrity,
		});
	} catch (error) {
		console.error('survey.getIntegrity error:', error);
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

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès admin requis.' });
		}

		const limit = Math.min(
			100,
			Math.max(1, Number.parseInt(req.query?.limit || '50', 10)),
		);
		const page = Math.max(1, Number.parseInt(req.query?.page || '1', 10));
		const skip = (page - 1) * limit;

		const OpinionModel = getBinaryOpinionModel(survey);
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
			OpinionModel.find({
				surveyId: survey._id,
				...queueQuery,
			})
				.select(
					'_id answer reason userPseudo userId createdAt fraudStatus fraudScore fraudReasons challengeType commentDeletedAt commentDeletedSource commentModerationLogId commentModerationReasonCodes commentModerationSource commentModerationLocale',
				)
				.sort({ createdAt: -1 })
				.skip(skip)
				.limit(limit)
				.lean(),
			OpinionModel.countDocuments({
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
		console.error('survey.getQuarantineQueue error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.deleteComment = async (req, res) => {
	try {
		const survey = await Survey.findById(req.params.id)
			.select('userId organizationId isClosed explain')
			.lean();
		if (!survey) {
			return res.status(404).json({
				code: SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
				message: 'Sondage introuvable',
			});
		}

		const opinion = await Opinion.findOne({
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
		io?.to(getClassicRoom(survey._id)).emit('classic:comment-deleted', {
			surveyId: String(survey._id),
			type: 'binary',
			opinionId: String(opinion._id),
			deletedAt: deletion.deletedAt,
		});
		await refreshAndEmitBroadcastSnapshot({
			io,
			surveyId: survey._id,
			reason: 'comment-deleted',
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
		console.error('survey.deleteComment error:', error);
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

		const opinion = await Opinion.findOne({
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
				message: "Vous devez être owner ou admin de l'organisation pour modérer ce commentaire.",
			});
		}

		const restoration = await restoreOpinionComment({
			opinion,
			actorUserId: req.userId,
		});

		const io = req.app.get('io');
		emitClassicBinaryOpinion(io, survey, opinion, 'classic:comment-restored');
		emitBroadcastStatus(io, survey._id, {
			reason: 'candidate:restored',
			sourceType: 'survey_comment',
			sourceId: String(opinion._id),
		});

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
		console.error('survey.restoreComment error:', error);
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

		const canManage = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès admin requis.' });
		}

		const OpinionModel = getBinaryOpinionModel(survey);
		const opinion = await OpinionModel.findOne({
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
			surveyType: survey.explain === false ? 'binary_flash' : 'binary',
			opinionModel: OpinionModel.modelName,
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
		const counts = await getBinaryCounts(survey._id, OpinionModel, 'clean');
		if (survey.explain === false) {
			io.to(`flash-binary-${survey._id}`).emit('flash:counts', {
				surveyId: String(survey._id),
				type: 'binary',
				totalOpinions: counts.totalOpinions,
				counts: { yes: counts.yesCount, no: counts.noCount },
				isClosed: Boolean(survey.isClosed),
			});
		} else {
			emitClassicBinaryCounts(io, survey, counts, survey.isClosed);
		}

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
			totalOpinions: counts.totalOpinions,
			occurredAt: new Date(),
		});
		try {
			await refreshAndEmitBroadcastSnapshot({
				io,
				surveyId: survey._id,
				reason: 'quarantine-reviewed',
			});
		} catch (broadcastError) {
			console.error(
				'survey.reviewQuarantineOpinion broadcast refresh error:',
				broadcastError?.message || broadcastError,
			);
		}

		const integrity = await getIntegritySnapshotForSurvey(
			OpinionModel,
			survey._id,
		);
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
		console.error('survey.reviewQuarantineOpinion error:', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
};
