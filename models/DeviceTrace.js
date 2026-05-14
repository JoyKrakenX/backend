/** @format */

const mongoose = require('mongoose');

const MACHINE_TRACE_DECISIONS = Object.freeze({
	ACCEPTED: 'accepted',
	QUARANTINED: 'quarantined',
	BLOCKED: 'blocked',
});

const getRetentionDays = () => {
	const configuredDays = Number(process.env.DEVICE_TRACE_RETENTION_DAYS || 400);
	if (!Number.isFinite(configuredDays)) return 400;
	return Math.max(30, Math.min(400, configuredDays));
};

const getDefaultExpiresAt = () =>
	new Date(Date.now() + getRetentionDays() * 24 * 60 * 60 * 1000);

const deviceTraceSchema = new mongoose.Schema(
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
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		opinionId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		machineSignatureVersion: {
			type: String,
			default: 'machine-signature-v2',
			index: true,
		},
		hardwareCoreHash: { type: String, default: null, index: true },
		renderingHash: { type: String, default: null, index: true },
		environmentHash: { type: String, default: null, index: true },
		networkContextHash: { type: String, default: null, index: true },
		browserProofHash: { type: String, default: null, index: true },
		componentHashes: {
			type: Map,
			of: String,
			default: {},
		},
		vpnRisk: {
			type: mongoose.Schema.Types.Mixed,
			default: null,
		},
		matchedFamilies: { type: [String], default: [] },
		similarityScore: { type: Number, min: 0, max: 100, default: 0 },
		decision: {
			type: String,
			enum: Object.values(MACHINE_TRACE_DECISIONS),
			default: MACHINE_TRACE_DECISIONS.ACCEPTED,
			index: true,
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

deviceTraceSchema.index(
	{ surveyId: 1, surveyType: 1, createdAt: -1 },
	{ name: 'survey_type_createdAt' },
);
deviceTraceSchema.index(
	{ surveyId: 1, surveyType: 1, hardwareCoreHash: 1, renderingHash: 1 },
	{ name: 'survey_machine_core_rendering', sparse: true },
);
deviceTraceSchema.index(
	{ userId: 1, createdAt: -1 },
	{ name: 'userId_createdAt' },
);
deviceTraceSchema.index(
	{ expiresAt: 1 },
	{ expireAfterSeconds: 0, name: 'expiresAt_ttl' },
);

module.exports = mongoose.model('DeviceTrace', deviceTraceSchema);
module.exports.MACHINE_TRACE_DECISIONS = MACHINE_TRACE_DECISIONS;
module.exports.getRetentionDays = getRetentionDays;
