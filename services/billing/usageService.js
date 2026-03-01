/** @format */

const mongoose = require('mongoose');

const UsageMonthly = require('../../models/UsageMonthly');
const UsageEvent = require('../../models/UsageEvent');
const { getPeriodKeyUtc } = require('./periodService');

const toObjectId = (id) =>
	mongoose.Types.ObjectId.isValid(String(id || ''))
		? mongoose.Types.ObjectId.createFromHexString(String(id))
		: null;

const buildDuplicateError = (error) =>
	Boolean(error && (error.code === 11000 || error?.message?.includes('duplicate key')));

const ensureMonthlyUsageDocument = async (organizationId, periodKey) => {
	await UsageMonthly.findOneAndUpdate(
		{ organizationId, periodKey },
		{
			$setOnInsert: {
				organizationId,
				periodKey,
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
		return { created: false, periodKey: getPeriodKeyUtc(date) };
	}

	const periodKey = getPeriodKeyUtc(date);

	try {
		await UsageEvent.create({
			organizationId: orgId,
			periodKey,
			action,
			amount,
			idempotencyKey: String(idempotencyKey),
			meta,
		});
		return { created: true, periodKey };
	} catch (error) {
		if (buildDuplicateError(error)) {
			return { created: false, periodKey };
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
			periodKey: registration.periodKey,
		}).lean();
	}

	await ensureMonthlyUsageDocument(orgId, registration.periodKey);
	await UsageMonthly.updateOne(
		{ organizationId: orgId, periodKey: registration.periodKey },
		{
			$inc: { [`counts.${counterKey}`]: Number(amount || 1) },
			$set: { lastUpdatedAt: new Date() },
		},
	);

	return UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: registration.periodKey,
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

	await ensureMonthlyUsageDocument(orgId, registration.periodKey);
	await UsageMonthly.updateOne(
		{
			organizationId: orgId,
			periodKey: registration.periodKey,
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
		periodKey: registration.periodKey,
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

	await ensureMonthlyUsageDocument(orgId, registration.periodKey);
	const usage = await UsageMonthly.findOne({
		organizationId: orgId,
		periodKey: registration.periodKey,
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
	const periodKey = getPeriodKeyUtc(date);
	return UsageMonthly.findOne({ organizationId: orgId, periodKey }).lean();
};

module.exports = {
	getMonthlyUsage,
	trackSurveyCreated,
	trackVote,
	trackExport,
	recordChatPeak,
	syncAdminsPeak,
	registerUsageEvent,
};
