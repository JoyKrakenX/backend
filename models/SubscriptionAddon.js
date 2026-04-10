/** @format */

const mongoose = require('mongoose');

const subscriptionAddonSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		subscriptionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Subscription',
			required: true,
			index: true,
		},
		invoiceId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Invoice',
			default: null,
			index: true,
		},
		code: { type: String, required: true, index: true },
		displayName: { type: String, default: '' },
		kind: {
			type: String,
			enum: ['recurring', 'one_time'],
			required: true,
		},
		status: {
			type: String,
			enum: ['pending', 'active', 'expired', 'canceled'],
			default: 'pending',
			index: true,
		},
		quantity: { type: Number, default: 1, min: 1 },
		priceUsd: { type: Number, default: 0 },
		startedAt: { type: Date, default: null },
		endsAt: { type: Date, default: null },
		activatedAt: { type: Date, default: null },
		canceledAt: { type: Date, default: null },
		metadata: { type: mongoose.Schema.Types.Mixed, default: null },
	},
	{
		timestamps: true,
	},
);

subscriptionAddonSchema.index(
	{ organizationId: 1, subscriptionId: 1, code: 1, status: 1, createdAt: -1 },
	{ name: 'subscription_addons_lookup' },
);

module.exports = mongoose.model('SubscriptionAddon', subscriptionAddonSchema);
