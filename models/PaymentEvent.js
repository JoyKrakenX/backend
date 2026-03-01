/** @format */

const mongoose = require('mongoose');

const paymentEventSchema = new mongoose.Schema(
	{
		provider: { type: String, required: true, default: 'fedapay' },
		eventId: { type: String, required: true, unique: true, index: true },
		providerEventId: { type: String, default: null, index: true, sparse: true },
		eventType: { type: String, default: null, index: true },
		signatureValid: { type: Boolean, default: null, index: true },
		txRef: { type: String, default: null, index: true },
		status: {
			type: String,
			enum: ['received', 'processed', 'ignored', 'failed'],
			default: 'received',
		},
		payload: { type: mongoose.Schema.Types.Mixed, default: null },
		processedAt: { type: Date, default: null },
	},
	{
		timestamps: true,
	},
);

paymentEventSchema.index(
	{ provider: 1, providerEventId: 1 },
	{ unique: true, sparse: true, name: 'unique_provider_event' },
);

module.exports = mongoose.model('PaymentEvent', paymentEventSchema);
