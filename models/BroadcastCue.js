/** @format */

const mongoose = require('mongoose');

const broadcastCueSchema = new mongoose.Schema(
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
			index: true,
		},
		surveyModel: {
			type: String,
			enum: ['Survey', 'Survey_2'],
			required: true,
		},
		surveyType: {
			type: String,
			enum: ['binary_classic', 'binary_flash', 'multiple_classic', 'multiple_flash'],
			required: true,
		},
		sourceType: {
			type: String,
			enum: ['chat_message', 'survey_comment'],
			required: true,
		},
		sourceModel: {
			type: String,
			enum: ['ChatMessage', 'Opinion', 'Opinion_2', 'Opinion_Flash', 'Opinion_2_Flash'],
			required: true,
		},
		sourceId: {
			type: mongoose.Schema.Types.ObjectId,
			required: true,
		},
		pseudoSnapshot: { type: String, default: '' },
		textSnapshot: { type: String, default: '' },
		answerSnapshot: { type: String, default: '' },
		sourceCreatedAt: { type: Date, default: null },
		engagementSnapshot: {
			likes: { type: Number, default: 0 },
			dislikes: { type: Number, default: 0 },
			score: { type: Number, default: 0 },
		},
		visibilityState: {
			type: String,
			enum: ['visible', 'removed', 'hidden', 'invalidated'],
			default: 'visible',
		},
		airState: {
			type: String,
			enum: ['approved', 'featured', 'expired', 'removed'],
			default: 'approved',
			index: true,
		},
		airOrder: { type: Number, default: 0 },
		broadcastScore: { type: Number, default: 0 },
		approvedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
		approvedAt: { type: Date, default: Date.now },
		featuredBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		featuredAt: { type: Date, default: null },
		expiredAt: { type: Date, default: null },
		removedAt: { type: Date, default: null },
		removedReason: { type: String, default: null },
	},
	{ timestamps: true },
);

broadcastCueSchema.index(
	{ surveyId: 1, sourceType: 1, sourceId: 1 },
	{ unique: true, name: 'broadcastCue_unique_source', background: true },
);

broadcastCueSchema.index(
	{ surveyId: 1, airState: 1, airOrder: 1, approvedAt: -1 },
	{ name: 'broadcastCue_survey_state_order', background: true },
);

module.exports = mongoose.model('BroadcastCue', broadcastCueSchema);

