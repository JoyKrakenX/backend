/** @format */

const mongoose = require('mongoose');

const DEVICE_ACCOUNT_LINK_KINDS = Object.freeze({
	MACHINE_SIGNATURE: 'machine_signature',
	MACHINE_STABLE_PROFILE: 'machine_stable_profile',
	RETROACTIVE_REVIEW: 'retroactive_review',
});

const getRetentionDays = () => {
	const configuredDays = Number(process.env.DEVICE_ACCOUNT_LINK_RETENTION_DAYS || 400);
	if (!Number.isFinite(configuredDays)) return 400;
	return Math.max(30, Math.min(400, configuredDays));
};

const getDefaultExpiresAt = () =>
	new Date(Date.now() + getRetentionDays() * 24 * 60 * 60 * 1000);

const deviceAccountLinkSchema = new mongoose.Schema(
	{
		userA: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		userB: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		linkKind: {
			type: String,
			enum: Object.values(DEVICE_ACCOUNT_LINK_KINDS),
			default: DEVICE_ACCOUNT_LINK_KINDS.MACHINE_SIGNATURE,
			index: true,
		},
		confidence: {
			type: Number,
			min: 0,
			max: 100,
			default: 0,
			index: true,
		},
		matchedFamilies: { type: [String], default: [] },
		firstSurveyId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		firstSurveyType: {
			type: String,
			enum: ['binary', 'multiple', 'binary_flash', 'multiple_flash', null],
			default: null,
			index: true,
		},
		firstTraceId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		matchedTraceId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		lastSeenAt: {
			type: Date,
			default: Date.now,
			index: true,
		},
		evidence: {
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

deviceAccountLinkSchema.index(
	{ userA: 1, userB: 1 },
	{ unique: true, name: 'unique_device_account_pair' },
);
deviceAccountLinkSchema.index(
	{ userA: 1, confidence: -1, lastSeenAt: -1 },
	{ name: 'userA_confidence_lastSeenAt' },
);
deviceAccountLinkSchema.index(
	{ userB: 1, confidence: -1, lastSeenAt: -1 },
	{ name: 'userB_confidence_lastSeenAt' },
);
deviceAccountLinkSchema.index(
	{ expiresAt: 1 },
	{ expireAfterSeconds: 0, name: 'expiresAt_ttl' },
);

module.exports = mongoose.model('DeviceAccountLink', deviceAccountLinkSchema);
module.exports.DEVICE_ACCOUNT_LINK_KINDS = DEVICE_ACCOUNT_LINK_KINDS;
module.exports.getRetentionDays = getRetentionDays;
