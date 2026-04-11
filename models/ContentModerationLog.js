/** @format */

const mongoose = require('mongoose');
const {
	CONTENT_MODERATION_CONFIG,
	CONTENT_MODERATION_SURFACES,
	CONTENT_MODERATION_SOURCES,
	CONTENT_MODERATION_VERDICTS,
} = require('../utils/contentModerationConfig');

const contentModerationLogSchema = new mongoose.Schema(
	{
		surface: {
			type: String,
			enum: Object.values(CONTENT_MODERATION_SURFACES),
			required: true,
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
		surveyModel: {
			type: String,
			default: null,
			index: true,
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
			index: true,
		},
		userPseudoSnapshot: {
			type: String,
			default: null,
			trim: true,
		},
		locale: {
			type: String,
			default: 'fr',
			index: true,
		},
		textHash: {
			type: String,
			required: true,
			index: true,
		},
		textPreview: {
			type: String,
			default: '',
			maxlength: 600,
		},
		textLength: {
			type: Number,
			default: 0,
			min: 0,
		},
		verdict: {
			type: String,
			enum: Object.values(CONTENT_MODERATION_VERDICTS),
			required: true,
			index: true,
		},
		enforced: {
			type: Boolean,
			default: false,
			index: true,
		},
		mode: {
			type: String,
			enum: ['shadow', 'enforce'],
			default: 'shadow',
		},
		source: {
			type: String,
			enum: CONTENT_MODERATION_SOURCES,
			default: 'fallback',
			index: true,
		},
		reasonCodes: {
			type: [String],
			default: [],
		},
		providerStatus: {
			type: String,
			enum: ['available', 'unavailable', 'skipped'],
			default: 'skipped',
		},
		providerMeta: {
			type: mongoose.Schema.Types.Mixed,
			default: null,
		},
		lexicalMatches: {
			type: [
				{
					locale: { type: String, required: true },
					term: { type: String, required: true },
				},
			],
			default: [],
		},
	},
	{
		timestamps: true,
	},
);

contentModerationLogSchema.index({ createdAt: -1 });
contentModerationLogSchema.index(
	{ createdAt: 1 },
	{
		expireAfterSeconds:
			Number(CONTENT_MODERATION_CONFIG.logRetentionDays || 45) * 24 * 60 * 60,
	},
);
contentModerationLogSchema.index({ surveyId: 1, surface: 1, createdAt: -1 });

module.exports = mongoose.model('ContentModerationLog', contentModerationLogSchema);
