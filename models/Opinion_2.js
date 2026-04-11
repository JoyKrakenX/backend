/** @format */

const mongoose = require('mongoose');

const opinion_2_Schema = new mongoose.Schema({
	answer: {
		type: String,
		required: true,
		trim: true,
	},

	reason: { type: String, required: true, trim: true },

	surveyId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Survey_2',
		required: true,
	},

	userId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},

	userPseudo: {
		type: String,
		required: true,
	},
	fraudStatus: {
		type: String,
		enum: ['accepted', 'quarantined', 'released', 'confirmed_fraud'],
		default: 'accepted',
		index: true,
	},
	fraudScore: { type: Number, default: 0, min: 0, max: 100 },
	fraudReasons: { type: [String], default: [] },
	antiFraudVersion: { type: Number, default: 1 },
	ipHash: { type: String, default: null, index: true },
	deviceHash: { type: String, default: null, index: true },
	reasonHash: { type: String, default: null },
	ipRiskProvider: {
		type: String,
		enum: ['ipqs', 'none'],
		default: 'none',
	},
	ipRiskScore: { type: Number, default: 0, min: 0, max: 100 },
	captchaVerified: { type: Boolean, default: false },
	challengeType: {
		type: String,
		enum: ['none', 'turnstile', 'email_otp'],
		default: 'none',
	},
	reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
	reviewedAt: { type: Date, default: null },
	commentDeletedAt: { type: Date, default: null },
	commentDeletedBy: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		default: null,
	},
	commentDeletedSource: {
		type: String,
		enum: ['manual', 'auto'],
		default: null,
	},
	commentModerationLogId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'ContentModerationLog',
		default: null,
	},
	commentModerationReasonCodes: { type: [String], default: [] },
	commentModerationSource: {
		type: String,
		enum: ['openai', 'ldnoobw', 'hybrid', 'fallback'],
		default: null,
	},
	commentModerationLocale: {
		type: String,
		default: null,
	},

	createdAt: { type: Date, default: Date.now },

	likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

	dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

opinion_2_Schema.index(
	{ userId: 1, surveyId: 1 },
	{ name: 'userId_surveyId', background: true },
);

opinion_2_Schema.index(
	{ surveyId: 1, userId: 1 },
	{ unique: true, name: 'unique_opinion_per_user_per_survey' }
);
opinion_2_Schema.index(
	{ surveyId: 1, fraudStatus: 1, createdAt: -1 },
	{ name: 'surveyId_fraudStatus_createdAt', background: true },
);
opinion_2_Schema.index(
	{ surveyId: 1, commentDeletedAt: 1, createdAt: -1 },
	{ name: 'surveyId_commentDeletedAt_createdAt', background: true },
);
opinion_2_Schema.index(
	{ surveyId: 1, commentDeletedSource: 1, createdAt: -1 },
	{ name: 'surveyId_commentDeletedSource_createdAt', background: true },
);
opinion_2_Schema.index(
	{ userId: 1, createdAt: -1 },
	{ name: 'userId_createdAt_fraud', background: true },
);
opinion_2_Schema.index(
	{ ipHash: 1, createdAt: -1 },
	{ name: 'ipHash_createdAt_fraud', background: true, sparse: true },
);
opinion_2_Schema.index(
	{ deviceHash: 1, createdAt: -1 },
	{ name: 'deviceHash_createdAt_fraud', background: true, sparse: true },
);

module.exports = mongoose.model('Opinion_2', opinion_2_Schema);
