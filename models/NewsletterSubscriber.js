/** @format */

const mongoose = require('mongoose');

const newsletterSubscriberSchema = new mongoose.Schema(
	{
		email: {
			type: String,
			required: true,
			trim: true,
			lowercase: true,
			unique: true,
			index: true,
		},
		status: {
			type: String,
			enum: ['pending', 'confirmed', 'unsubscribed'],
			default: 'pending',
			index: true,
		},
		locale: {
			type: String,
			enum: ['fr', 'en', 'es', 'de'],
			default: 'fr',
		},
		sourcePage: {
			type: String,
			default: 'unknown',
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
		confirmTokenHash: {
			type: String,
			default: null,
		},
		confirmTokenExpiresAt: {
			type: Date,
			default: null,
		},
		confirmedAt: {
			type: Date,
			default: null,
		},
		unsubscribeTokenHash: {
			type: String,
			default: null,
		},
		unsubscribedAt: {
			type: Date,
			default: null,
		},
		confirmEmailLastAttemptAt: {
			type: Date,
			default: null,
		},
		confirmEmailLastSentAt: {
			type: Date,
			default: null,
		},
		confirmEmailAttemptWindowStartAt: {
			type: Date,
			default: null,
		},
		confirmEmailAttemptCount24h: {
			type: Number,
			default: 0,
		},
		confirmEmailLastErrorCode: {
			type: String,
			default: null,
		},
		metadata: {
			ip: { type: String, default: null },
			userAgent: { type: String, default: null },
		},
	},
	{ timestamps: true },
);

module.exports = mongoose.model(
	'NewsletterSubscriber',
	newsletterSubscriberSchema,
);
