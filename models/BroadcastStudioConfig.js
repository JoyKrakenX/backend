/** @format */

const mongoose = require('mongoose');

const safeMarginSchema = new mongoose.Schema(
	{
		top: { type: Number, default: 48, min: 0, max: 240 },
		right: { type: Number, default: 48, min: 0, max: 240 },
		bottom: { type: Number, default: 48, min: 0, max: 240 },
		left: { type: Number, default: 48, min: 0, max: 240 },
	},
	{ _id: false },
);

const broadcastStudioConfigSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		surveyId: {
			type: mongoose.Schema.Types.ObjectId,
			refPath: 'surveyModel',
			required: true,
			unique: true,
		},
		surveyModel: {
			type: String,
			enum: ['Survey', 'Survey_2'],
			required: true,
		},
		defaultLayout: {
			type: String,
			enum: ['results', 'chat', 'combined'],
			default: 'combined',
		},
		position: {
			type: String,
			enum: ['bottom', 'bottom-right', 'full'],
			default: 'bottom-right',
		},
		tickerEnabled: { type: Boolean, default: true },
		tickerSpeed: { type: Number, default: 18, min: 8, max: 90 },
		transparency: { type: Number, default: 0.9, min: 0.2, max: 1 },
		maxTextLength: { type: Number, default: 180, min: 40, max: 320 },
		featuredDurationSeconds: { type: Number, default: 16, min: 6, max: 60 },
		maxTickerItems: { type: Number, default: 10, min: 1, max: 25 },
		minimalBranding: { type: Boolean, default: true },
		safeMargins: { type: safeMarginSchema, default: () => ({}) },
		updatedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model('BroadcastStudioConfig', broadcastStudioConfigSchema);

