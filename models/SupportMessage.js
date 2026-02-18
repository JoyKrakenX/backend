/** @format */

const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema(
	{
		conversationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'SupportConversation',
			required: true,
			index: true,
		},
		senderRole: {
			type: String,
			enum: ['client', 'agent', 'system'],
			required: true,
			index: true,
		},
		senderUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		content: {
			type: String,
			required: true,
			trim: true,
			maxlength: 4000,
		},
		attachments: [
			{
				path: { type: String, default: null },
				mimeType: { type: String, default: null },
				name: { type: String, default: null },
				size: { type: Number, default: 0 },
			},
		],
		readBy: [
			{
				userId: {
					type: mongoose.Schema.Types.ObjectId,
					ref: 'User',
					required: true,
				},
				readAt: {
					type: Date,
					default: Date.now,
				},
			},
		],
	},
	{ timestamps: true },
);

supportMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);

