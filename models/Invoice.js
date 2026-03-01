/** @format */

const mongoose = require('mongoose');

const invoiceLineItemSchema = new mongoose.Schema(
	{
		code: { type: String, required: true },
		description: { type: String, required: true },
		quantity: { type: Number, default: 1 },
		unitPriceUsd: { type: Number, default: 0 },
		amountUsd: { type: Number, default: 0 },
	},
	{ _id: false },
);

const invoiceSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		invoiceKey: { type: String, default: null, unique: true, sparse: true, index: true },
		subscriptionId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Subscription',
			required: true,
			index: true,
		},
		periodKey: { type: String, required: true, index: true },
		planCode: { type: String, required: true },
		currency: { type: String, default: 'USD' },
		kind: {
			type: String,
			enum: ['renewal', 'upgrade', 'retry', 'manual'],
			default: 'renewal',
		},
		status: {
			type: String,
			enum: ['pending', 'paid', 'failed', 'void', 'refunded'],
			default: 'pending',
			index: true,
		},
		baseAmountUsd: { type: Number, default: 0 },
		overage: {
			votesUsd: { type: Number, default: 0 },
			chatUsd: { type: Number, default: 0 },
			adminsUsd: { type: Number, default: 0 },
			totalUsd: { type: Number, default: 0 },
		},
		totalAmountUsd: { type: Number, required: true },
		dueAt: { type: Date, default: null },
		paidAt: { type: Date, default: null },
		fx: {
			baseCurrency: { type: String, default: 'USD' },
			quoteCurrency: { type: String, default: null },
			rate: { type: Number, default: null },
			source: { type: String, default: null },
			asOf: { type: Date, default: null },
			lockedAt: { type: Date, default: null },
			lockExpiresAt: { type: Date, default: null },
		},
		charge: {
			amount: { type: Number, default: null },
			currency: { type: String, default: null },
			minorUnitAmount: { type: Number, default: null },
		},
		provider: {
			name: { type: String, default: 'fedapay' },
			txRef: { type: String, default: null, index: true, sparse: true },
			transactionId: { type: String, default: null },
			checkoutLink: { type: String, default: null },
			rawStatus: { type: String, default: null },
			providerEventId: { type: String, default: null, index: true, sparse: true },
			chargeMode: {
				type: String,
				enum: ['checkout', 'manual', 'tokenized', 'unknown'],
				default: 'unknown',
			},
			paymentMethodUsed: { type: String, default: null },
		},
		lineItems: { type: [invoiceLineItemSchema], default: [] },
		metadata: { type: mongoose.Schema.Types.Mixed, default: null },
	},
	{
		timestamps: true,
	},
);

invoiceSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Invoice', invoiceSchema);
