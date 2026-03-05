/** @format */

const mongoose = require('mongoose');
const { FRAUD_CONFIG } = require('../utils/fraudConfig');

const fraudDecisionLogSchema = new mongoose.Schema(
	{
		event: {
			type: String,
			enum: [
				'vote_decision',
				'profile_decision',
				'otp_start',
				'otp_verify',
				'quarantine_review',
				'batch_retro_quarantine',
			],
			required: true,
			index: true,
		},
		decision: {
			type: String,
			enum: [
				'accepted',
				'quarantined',
				'blocked',
				'turnstile_required',
				'email_otp_required',
				'released',
				'confirmed_fraud',
			],
			required: true,
			index: true,
		},
		actionType: {
			type: String,
			enum: ['vote', 'complete_profile', 'otp', 'review', 'batch'],
			required: true,
			index: true,
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
			index: true,
		},
		surveyId: {
			type: mongoose.Schema.Types.ObjectId,
			default: null,
			index: true,
		},
		surveyType: {
			type: String,
			enum: ['binary', 'multiple', 'binary_flash', 'multiple_flash', 'unknown'],
			default: 'unknown',
			index: true,
		},
		opinionModel: {
			type: String,
			default: null,
			index: true,
		},
		ipHash: { type: String, default: null, index: true },
		deviceHash: { type: String, default: null, index: true },
		riskScore: { type: Number, default: 0, min: 0, max: 100, index: true },
		reasons: { type: [String], default: [] },
		challengeType: {
			type: String,
			enum: ['none', 'turnstile', 'email_otp'],
			default: 'none',
		},
		metrics: { type: mongoose.Schema.Types.Mixed, default: null },
		providerMeta: { type: mongoose.Schema.Types.Mixed, default: null },
		meta: { type: mongoose.Schema.Types.Mixed, default: null },
	},
	{
		timestamps: true,
	},
);

fraudDecisionLogSchema.index({ createdAt: -1 });
fraudDecisionLogSchema.index(
	{ createdAt: 1 },
	{ expireAfterSeconds: Number(FRAUD_CONFIG.retentionDays || 90) * 24 * 60 * 60 },
);

module.exports = mongoose.model('FraudDecisionLog', fraudDecisionLogSchema);
