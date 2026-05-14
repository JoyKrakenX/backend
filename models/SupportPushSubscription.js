/** @format */

const mongoose = require('mongoose');

const PUSH_CHANNELS = [
	'support_queue',
	'support_reply',
	'survey_new',
	'survey_closed',
	'chat_reply',
];

const supportPushSubscriptionSchema = new mongoose.Schema(
	{
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		role: {
			type: String,
			enum: ['user', 'support', 'admin'],
			required: true,
			index: true,
		},
		channel: {
			type: String,
			enum: PUSH_CHANNELS,
			required: true,
			index: true,
		},
		channels: {
			type: [
				{
					type: String,
					enum: PUSH_CHANNELS,
				},
			],
			default: [],
			index: true,
		},
		endpoint: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		keys: {
			p256dh: { type: String, required: true },
			auth: { type: String, required: true },
		},
		userAgent: {
			type: String,
			default: null,
			maxlength: 500,
		},
		platform: {
			type: String,
			default: null,
			maxlength: 80,
		},
		deviceLabel: {
			type: String,
			default: null,
			maxlength: 120,
		},
		locale: {
			type: String,
			default: 'fr',
			maxlength: 8,
		},
		enabled: {
			type: Boolean,
			default: true,
			index: true,
		},
		lastSeenAt: {
			type: Date,
			default: Date.now,
			index: true,
		},
	},
	{ timestamps: true },
);

supportPushSubscriptionSchema.index({ userId: 1, endpoint: 1 }, { unique: true });
supportPushSubscriptionSchema.index({ role: 1, channel: 1, enabled: 1, updatedAt: -1 });
supportPushSubscriptionSchema.index({ userId: 1, channel: 1, enabled: 1, updatedAt: -1 });
supportPushSubscriptionSchema.index({ role: 1, channels: 1, enabled: 1, updatedAt: -1 });
supportPushSubscriptionSchema.index({ userId: 1, channels: 1, enabled: 1, updatedAt: -1 });

module.exports = mongoose.model(
	'SupportPushSubscription',
	supportPushSubscriptionSchema,
);
