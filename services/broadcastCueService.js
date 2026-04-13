/** @format */

const BroadcastCue = require('../models/BroadcastCue');
const {
	findCandidateSource,
	serializeCue,
	scoreCandidate,
} = require('./broadcastCandidateService');

const nextAirOrder = async (surveyId) => {
	const row = await BroadcastCue.findOne({ surveyId })
		.sort({ airOrder: -1, approvedAt: -1 })
		.select('airOrder')
		.lean();
	return Number(row?.airOrder || 0) + 1;
};

const createOrApproveBroadcastCue = async ({
	surveyContext,
	sourceType,
	sourceId,
	actorUserId,
	feature = false,
} = {}) => {
	const candidate = await findCandidateSource({ surveyContext, sourceType, sourceId });
	if (!candidate) {
		const error = new Error('Source ineligible for broadcast');
		error.status = 409;
		throw error;
	}
	const order = await nextAirOrder(surveyContext.survey._id);
	const score = scoreCandidate({
		candidate,
		authorCounts: new Map(),
		seenTexts: new Set(),
		now: Date.now(),
	});
	const cue = await BroadcastCue.findOneAndUpdate(
		{
			surveyId: surveyContext.survey._id,
			sourceType,
			sourceId,
		},
		{
			$set: {
				organizationId: surveyContext.organizationId,
				surveyModel: surveyContext.surveyModel,
				surveyType: surveyContext.surveyKind,
				sourceModel: candidate.sourceModel,
				pseudoSnapshot: candidate.pseudoSnapshot,
				textSnapshot: candidate.textSnapshot,
				answerSnapshot: candidate.answerSnapshot,
				sourceCreatedAt: candidate.createdAt,
				engagementSnapshot: candidate.engagement,
				visibilityState: candidate.visibilityState,
				airState: feature ? 'featured' : 'approved',
				broadcastScore: score,
				approvedBy: actorUserId,
				approvedAt: new Date(),
				featuredBy: feature ? actorUserId : null,
				featuredAt: feature ? new Date() : null,
				removedAt: null,
				removedReason: null,
				expiredAt: null,
				airOrder: order,
			},
			$setOnInsert: {
				surveyId: surveyContext.survey._id,
				sourceId,
				sourceType,
			},
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	);
	if (feature) {
		await BroadcastCue.updateMany(
			{
				surveyId: surveyContext.survey._id,
				_id: { $ne: cue._id },
				airState: 'featured',
				removedAt: null,
				expiredAt: null,
			},
			{
				$set: {
					airState: 'approved',
					featuredAt: null,
					featuredBy: null,
				},
			},
		);
	}
	const refreshed = await BroadcastCue.findById(cue._id).lean();
	return serializeCue(refreshed);
};

const updateBroadcastCueAction = async ({
	surveyContext,
	cueId,
	action,
	actorUserId,
	airOrder,
} = {}) => {
	const cue = await BroadcastCue.findOne({
		_id: cueId,
		surveyId: surveyContext.survey._id,
	});
	if (!cue) {
		const error = new Error('Broadcast cue not found');
		error.status = 404;
		throw error;
	}
	const now = new Date();
	switch (String(action || '')) {
		case 'feature':
			await BroadcastCue.updateMany(
				{
					surveyId: surveyContext.survey._id,
					_id: { $ne: cue._id },
					airState: 'featured',
					removedAt: null,
					expiredAt: null,
				},
				{
					$set: {
						airState: 'approved',
						featuredAt: null,
						featuredBy: null,
					},
				},
			);
			cue.airState = 'featured';
			cue.featuredAt = now;
			cue.featuredBy = actorUserId;
			cue.removedAt = null;
			cue.expiredAt = null;
			break;
		case 'unfeature':
			cue.airState = 'approved';
			cue.featuredAt = null;
			cue.featuredBy = null;
			break;
		case 'reorder':
			cue.airOrder = Math.max(1, Number(airOrder || cue.airOrder || 1));
			break;
		case 'unapprove':
			cue.airState = 'removed';
			cue.removedAt = now;
			cue.removedReason = 'manual_unapprove';
			cue.featuredAt = null;
			cue.featuredBy = null;
			break;
		case 'expireNow':
			cue.airState = 'expired';
			cue.expiredAt = now;
			cue.featuredAt = null;
			cue.featuredBy = null;
			break;
		default: {
			const error = new Error('Unsupported cue action');
			error.status = 400;
			throw error;
		}
	}
	cue.approvedBy = actorUserId;
	await cue.save();
	const refreshed = await BroadcastCue.findById(cue._id).lean();
	return serializeCue(refreshed);
};

module.exports = {
	createOrApproveBroadcastCue,
	updateBroadcastCueAction,
};

