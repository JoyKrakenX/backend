/** @format */

const mongoose = require('mongoose');

const chatModerationStateSchema = new mongoose.Schema(
	{
		surveyId: {
			type: mongoose.Schema.Types.ObjectId,
			required: true,
			refPath: 'surveyModel',
		},
		surveyModel: {
			type: String,
			required: true,
			enum: ['Survey', 'Survey_2'],
		},
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
		},
		userPseudoSnapshot: {
			type: String,
			default: 'Utilisateur',
			trim: true,
			maxlength: 160,
		},
		muteUntil: {
			type: Date,
			default: null,
		},
		bannedAt: {
			type: Date,
			default: null,
		},
		lastActionByUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		lastSourceMessageId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'ChatMessage',
			default: null,
		},
	},
	{
		timestamps: true,
	},
);

chatModerationStateSchema.index(
	{ surveyId: 1, surveyModel: 1, userId: 1 },
	{ unique: true, name: 'unique_chat_moderation_state' },
);
chatModerationStateSchema.index(
	{ organizationId: 1, surveyId: 1, surveyModel: 1 },
	{ name: 'chat_moderation_org_scope' },
);
chatModerationStateSchema.index({ bannedAt: 1 }, { name: 'chat_moderation_banned_at' });
chatModerationStateSchema.index({ muteUntil: 1 }, { name: 'chat_moderation_mute_until' });

module.exports = mongoose.model(
	'ChatModerationState',
	chatModerationStateSchema,
);
