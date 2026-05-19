/** @format */

const mongoose = require('mongoose');

const surveyAnalyticsEventSchema = new mongoose.Schema({
	surveyId: {
		type: mongoose.Schema.Types.ObjectId,
		required: true,
		index: true,
		refPath: 'surveyModel',
	},
	surveyModel: {
		type: String,
		required: true,
		enum: ['Survey', 'Survey_2'],
		index: true,
	},
	eventType: {
		type: String,
		required: true,
		enum: ['scan', 'vote_conversion', 'chat_emoji'],
		index: true,
	},
	scanId: {
		type: String,
		trim: true,
		index: true,
		default: null,
	},
	source: {
		type: String,
		enum: ['tv', 'replay', 'social', 'direct', 'unknown'],
		default: 'unknown',
		index: true,
	},
	referrerHost: {
		type: String,
		trim: true,
		default: '',
	},
	countryCode: {
		type: String,
		trim: true,
		uppercase: true,
		default: 'XX',
		index: true,
	},
	countryName: {
		type: String,
		trim: true,
		default: 'Unknown',
	},
	userId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		default: null,
		index: true,
	},
	metadata: {
		type: mongoose.Schema.Types.Mixed,
		default: {},
	},
	createdAt: {
		type: Date,
		default: Date.now,
		index: true,
	},
});

surveyAnalyticsEventSchema.index(
	{ surveyId: 1, eventType: 1, createdAt: -1 },
	{ name: 'survey_event_createdAt' },
);
surveyAnalyticsEventSchema.index(
	{ scanId: 1, eventType: 1 },
	{ name: 'scan_event_type', sparse: true },
);

module.exports = mongoose.model('SurveyAnalyticsEvent', surveyAnalyticsEventSchema);
