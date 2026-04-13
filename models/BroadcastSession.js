/** @format */

const mongoose = require('mongoose');

const broadcastSessionSchema = new mongoose.Schema(
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
		mode: {
			type: String,
			enum: ['results', 'chat', 'combined'],
			required: true,
		},
		outputs: {
			type: [String],
			enum: ['overlay', 'feed'],
			default: ['overlay', 'feed'],
		},
		createdBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
		revokedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		revokedAt: { type: Date, default: null },
		expiresAt: { type: Date, required: true, index: true },
		lastAccessedAt: { type: Date, default: null },
		name: { type: String, default: '' },
	},
	{ timestamps: true },
);

broadcastSessionSchema.index(
	{ surveyId: 1, mode: 1, revokedAt: 1, expiresAt: 1 },
	{ name: 'broadcastSession_survey_mode_status', background: true },
);

module.exports = mongoose.model('BroadcastSession', broadcastSessionSchema);

