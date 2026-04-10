/** @format */

const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			unique: true,
			index: true,
		},
		planCode: { type: String, required: true, index: true },
		trialPlanCode: { type: String, default: null, index: true },
		status: {
			type: String,
			enum: [
				'trialing',
				'active',
				'grace',
				'past_due',
				'suspended',
				'canceled',
			],
			default: 'trialing',
			index: true,
		},
		trialStartedAt: { type: Date, default: null },
		trialEndsAt: { type: Date, default: null },
		graceEndsAt: { type: Date, default: null },
		currentPeriodStartAt: { type: Date, default: null },
		currentPeriodEndAt: { type: Date, default: null },
		nextBillingAt: { type: Date, default: null },
		lastPaidAt: { type: Date, default: null },
		readOnlySince: { type: Date, default: null },
		canceledAt: { type: Date, default: null },
		provider: {
			name: { type: String, default: 'fedapay' },
			customerId: { type: String, default: null },
			planId: { type: String, default: null },
			subscriptionId: { type: String, default: null },
			paymentMethodId: { type: String, default: null, index: true },
			paymentMethodType: { type: String, default: null },
			last4: { type: String, default: null },
			expMonth: { type: Number, default: null },
			expYear: { type: Number, default: null },
			canAutoCharge: { type: Boolean, default: false, index: true },
		},
	},
	{
		timestamps: true,
	},
);

module.exports = mongoose.model('Subscription', subscriptionSchema);
