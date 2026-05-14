/** @format */

const mongoose = require('mongoose');

const DEVICE_LOCK_KINDS = Object.freeze({
	COOKIE: 'cookie',
	WEBCRYPTO: 'webcrypto',
	FINGERPRINT: 'fingerprint',
	HARDWARE: 'hardware',
	MACHINE_STRONG: 'machine_strong',
	MACHINE_NETWORK: 'machine_network',
	MACHINE_STABLE_NETWORK: 'machine_stable_network',
	MACHINE_STABLE_VARIANT_NETWORK: 'machine_stable_variant_network',
	MACHINE_STABLE_VARIANT_HARDWARE: 'machine_stable_variant_hardware',
});

const DEVICE_LOCK_STATUSES = Object.freeze({
	PENDING: 'pending',
	COMMITTED: 'committed',
});

const getRetentionDays = () => {
	const configuredDays = Number(process.env.DEVICE_VOTE_LOCK_RETENTION_DAYS || 400);
	if (!Number.isFinite(configuredDays)) return 400;
	return Math.max(30, Math.min(1095, configuredDays));
};

const getDefaultExpiresAt = () =>
	new Date(Date.now() + getRetentionDays() * 24 * 60 * 60 * 1000);

const deviceVoteLockSchema = new mongoose.Schema(
	{
		surveyId: {
			type: mongoose.Schema.Types.ObjectId,
			required: true,
			index: true,
		},
		surveyType: {
			type: String,
			enum: ['binary', 'multiple', 'binary_flash', 'multiple_flash'],
			required: true,
			index: true,
		},
		lockKeyHash: {
			type: String,
			required: true,
		},
		lockKind: {
			type: String,
			enum: Object.values(DEVICE_LOCK_KINDS),
			required: true,
			index: true,
		},
		firstUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		firstOpinionId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		confidence: {
			type: Number,
			min: 0,
			max: 100,
			required: true,
		},
		status: {
			type: String,
			enum: Object.values(DEVICE_LOCK_STATUSES),
			default: DEVICE_LOCK_STATUSES.PENDING,
			index: true,
		},
		signalsVersion: {
			type: String,
			default: 'device-integrity-v2',
		},
		meta: {
			type: mongoose.Schema.Types.Mixed,
			default: null,
		},
		expiresAt: {
			type: Date,
			default: getDefaultExpiresAt,
		},
	},
	{
		timestamps: true,
	},
);

deviceVoteLockSchema.index(
	{ surveyId: 1, surveyType: 1, lockKeyHash: 1 },
	{ unique: true, name: 'unique_device_vote_lock_per_survey' },
);
deviceVoteLockSchema.index(
	{ firstUserId: 1, createdAt: -1 },
	{ name: 'firstUserId_createdAt' },
);
deviceVoteLockSchema.index(
	{ createdAt: -1 },
	{ name: 'createdAt_desc' },
);
deviceVoteLockSchema.index(
	{ expiresAt: 1 },
	{ expireAfterSeconds: 0, name: 'expiresAt_ttl' },
);

module.exports = mongoose.model('DeviceVoteLock', deviceVoteLockSchema);
module.exports.DEVICE_LOCK_KINDS = DEVICE_LOCK_KINDS;
module.exports.DEVICE_LOCK_STATUSES = DEVICE_LOCK_STATUSES;
module.exports.getRetentionDays = getRetentionDays;
