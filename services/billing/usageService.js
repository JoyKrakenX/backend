/** @format */

const mongoose = require('mongoose');

const UsageMonthly = require('../../models/UsageMonthly');
const UsageEvent = require('../../models/UsageEvent');
const { buildUsageWindowDescriptor } = require('./periodService');
const { getOrganizationSubscription } = require('./subscriptionService');

const toObjectId = (id) =>
	mongoose.Types.ObjectId.isValid(String(id || ''))
		? mongoose.Types.ObjectId.createFromHexString(String(id))
		: null;

const buildDuplicateError = (error) =>
	Boolean(error && (error.code === 11000 || error?.message?.includes('duplicate key')));

const resolveUsageWindowDescriptor = async (organizationId, date = new Date()) => {
	const subscription = await getOrganizationSubscription(organizationId, date);
	return buildUsageWindowDescriptor({
		subscription,
		date,
	});
};

const ensureUsageDocument = async (organizationId, descriptor) => {
	await UsageMonthly.findOneAndUpdate(
		{ organizationId, periodKey: descriptor.periodKey },
		{
			$setOnInsert: {
				organizationId,
				periodKey: descriptor.periodKey,
				periodType: descriptor.periodType,
				periodStartAt: descriptor.periodStartAt,
				periodEndAt: descriptor.periodEndAt,
				counts: {
					votes: 0,
					surveys: 0,
					exports: 0,
				},
				chatPeakMax: 0,
				chatPeakByRoom: {},
				adminsPeak: 1,
			},
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	);
};

const registerUsageEvent = async ({
	organizationId,
	action,
	amount = 1,
	idempotencyKey,
	meta = null,
	date = new Date(),
}) => {
	const orgId = toObjectId(organizationId);
	if (!orgId || !idempotencyKey) {
		const descriptor = await resolveUsageWindowDescriptor(organizationId, date);
		return { created: false, descriptor };
	}

	const descriptor = await resolveUsageWindowDescriptor(orgId, date);

	try {
		await UsageEvent.create({
			organizationId: orgId,
			periodKey: descriptor.periodKey,
			periodType: descriptor.periodType,
			periodStartAt: descriptor.periodStartAt,
			periodEndAt: descriptor.periodEndAt,
			action,
			amount,
			idempotencyKey: String(idempotencyKey),
			meta,
		});
		return { created: true, descriptor };
	} catch (error) {
		if (buildDuplicateError(error)) {
			return { created: false, descriptor };
		}
		throw error;
	}
};

const incrementCounter = async ({
	organizationId,
	counterKey,
	amount = 1,
	idempotencyKey,
	meta = null,
	action,
	date = new Date(),
}) => {
	const orgId = toObjectId(organizationId);
	if (!orgId || !counterKey) return null;

	const registration = await registerUsageEvent({
		organizationId: orgId,
		action,
		amount,
		idempotencyKey,
		meta,
		date,
	});
	if (!registration.created) {
		return UsageMonthly.findOne({
			organizationId: orgId,
			periodKey: registration.descriptor.periodKey,
		}).lean();
	}

	await ensureUsageDocument(orgId, registration.descriptor);
	await UsageMonthly.updateOne(
		{ organizationId: orgId, periodKey: registration.descriptor.periodKey },
		{
			$inc: { [`counts.${counterKey}`]: Number(amount || 1) },
			$set: { lastUpdatedAt: new Date() },
		},
	);

	return UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: registration.descriptor.periodKey,
	}).lean();
};

const trackSurveyCreated = async (payload) =>
	incrementCounter({
		...payload,
		counterKey: 'surveys',
		action: 'survey_create',
	});

const trackVote = async (payload) =>
	incrementCounter({
		...payload,
		counterKey: 'votes',
		action: 'vote',
	});

const trackExport = async (payload) =>
	incrementCounter({
		...payload,
		counterKey: 'exports',
		action: 'export',
	});

const syncAdminsPeak = async ({
	organizationId,
	adminsCount,
	idempotencyKey,
	date = new Date(),
}) => {
	const orgId = toObjectId(organizationId);
	if (!orgId || !Number.isFinite(Number(adminsCount))) return null;
	const safeAdminsCount = Math.max(0, Math.trunc(Number(adminsCount)));

	const registration = await registerUsageEvent({
		organizationId: orgId,
		action: 'admin_peak_sync',
		amount: safeAdminsCount,
		idempotencyKey,
		meta: { adminsCount: safeAdminsCount },
		date,
	});

	await ensureUsageDocument(orgId, registration.descriptor);
	await UsageMonthly.updateOne(
		{
			organizationId: orgId,
			periodKey: registration.descriptor.periodKey,
			adminsPeak: { $lt: safeAdminsCount },
		},
		{
			$set: {
				adminsPeak: safeAdminsCount,
				lastUpdatedAt: new Date(),
			},
		},
	);

	return UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: registration.descriptor.periodKey,
	}).lean();
};

const recordChatPeak = async ({
	organizationId,
	roomId,
	concurrentCount,
	idempotencyKey,
	date = new Date(),
}) => {
	const orgId = toObjectId(organizationId);
	if (!orgId || !roomId || !Number.isFinite(Number(concurrentCount))) return null;

	const safeConcurrentCount = Math.max(0, Math.trunc(Number(concurrentCount)));
	const registration = await registerUsageEvent({
		organizationId: orgId,
		action: 'chat_peak',
		amount: safeConcurrentCount,
		idempotencyKey,
		meta: {
			roomId: String(roomId),
			concurrentCount: safeConcurrentCount,
		},
		date,
	});

	await ensureUsageDocument(orgId, registration.descriptor);
	const usage = await UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: registration.descriptor.periodKey,
	});
	if (!usage) return null;

	const currentRoomPeak = Number(usage.chatPeakByRoom?.get(String(roomId)) || 0);
	if (safeConcurrentCount > currentRoomPeak) {
		usage.chatPeakByRoom.set(String(roomId), safeConcurrentCount);
	}
	if (safeConcurrentCount > Number(usage.chatPeakMax || 0)) {
		usage.chatPeakMax = safeConcurrentCount;
	}
	usage.lastUpdatedAt = new Date();
	await usage.save();
	return usage.toObject();
};

const getMonthlyUsage = async (organizationId, date = new Date()) => {
	const orgId = toObjectId(organizationId);
	if (!orgId) return null;
	const descriptor = await resolveUsageWindowDescriptor(orgId, date);
	const usage = await UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: descriptor.periodKey,
	}).lean();
	if (!usage) return null;
	return {
		...usage,
		periodKey: descriptor.periodKey,
		periodType: descriptor.periodType,
		periodStartAt: descriptor.periodStartAt,
		periodEndAt: descriptor.periodEndAt,
	};
};

module.exports = {
	getMonthlyUsage,
	resolveUsageWindowDescriptor,
	trackSurveyCreated,
	trackVote,
	trackExport,
	recordChatPeak,
	syncAdminsPeak,
	registerUsageEvent,
};
