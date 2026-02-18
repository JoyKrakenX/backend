/** @format */

const mongoose = require('mongoose');

const ticketReplySchema = new mongoose.Schema(
	{
		senderRole: {
			type: String,
			enum: ['support', 'admin', 'system'],
			required: true,
		},
		senderUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		message: {
			type: String,
			required: true,
			trim: true,
			maxlength: 4000,
		},
		createdAt: {
			type: Date,
			default: Date.now,
		},
	},
	{ _id: false },
);

const supportTicketSchema = new mongoose.Schema(
	{
		ticketRef: {
			type: String,
			required: true,
			unique: true,
			index: true,
		},
		channelPage: {
			type: String,
			enum: ['about', 'privacy', 'cgu', 'contact', 'legal', 'accessibility'],
			required: true,
			default: 'contact',
			index: true,
		},
		category: {
			type: String,
			required: true,
			trim: true,
			default: 'general',
			index: true,
		},
		subject: {
			type: String,
			required: true,
			trim: true,
			maxlength: 180,
		},
		message: {
			type: String,
			required: true,
			trim: true,
			maxlength: 6000,
		},
		name: {
			type: String,
			required: true,
			trim: true,
			maxlength: 120,
		},
		email: {
			type: String,
			required: true,
			trim: true,
			lowercase: true,
			maxlength: 180,
			index: true,
		},
		locale: {
			type: String,
			enum: ['fr', 'en', 'es', 'de'],
			default: 'fr',
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		attachment: {
			path: { type: String, default: null },
			originalName: { type: String, default: null },
			mimeType: { type: String, default: null },
			size: { type: Number, default: 0 },
		},
		status: {
			type: String,
			enum: ['new', 'in_progress', 'resolved', 'closed'],
			default: 'new',
			index: true,
		},
		priority: {
			type: String,
			enum: ['low', 'normal', 'high', 'urgent'],
			default: 'normal',
			index: true,
		},
		assignedTo: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		firstResponseAt: {
			type: Date,
			default: null,
		},
		resolvedAt: {
			type: Date,
			default: null,
		},
		replies: [ticketReplySchema],
	},
	{ timestamps: true },
);

supportTicketSchema.index({ status: 1, priority: 1, createdAt: -1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);

