/** @format */

const mongoose = require('mongoose');

const supportConversationSchema = new mongoose.Schema(
	{
		conversationRef: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		clientUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
			index: true,
		},
		guestProfile: {
			name: { type: String, default: null },
			email: { type: String, default: null },
		},
		status: {
			type: String,
			enum: ['waiting', 'assigned', 'closed'],
			default: 'waiting',
			index: true,
		},
		category: {
			type: String,
			default: 'general',
			index: true,
		},
		priorityScore: {
			type: Number,
			default: 0,
			index: true,
		},
		assignedAgentId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
			index: true,
		},
		channelPage: {
			type: String,
			default: 'contact',
		},
		locale: {
			type: String,
			enum: ['fr', 'en', 'es', 'de'],
			default: 'fr',
		},
		openedAt: {
			type: Date,
			default: Date.now,
		},
		firstResponseAt: {
			type: Date,
			default: null,
		},
		lastMessageAt: {
			type: Date,
			default: Date.now,
			index: true,
		},
		closedAt: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true },
);

supportConversationSchema.index({ status: 1, priorityScore: -1, openedAt: 1 });

module.exports = mongoose.model('SupportConversation', supportConversationSchema);

