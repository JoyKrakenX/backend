/** @format */

const mongoose = require('mongoose');

const usageMonthlySchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		periodKey: { type: String, required: true, index: true },
		periodType: {
			type: String,
			enum: ['calendar_month', 'billing_cycle'],
			default: 'calendar_month',
		},
		periodStartAt: { type: Date, default: null },
		periodEndAt: { type: Date, default: null },
		counts: {
			votes: { type: Number, default: 0 },
			surveys: { type: Number, default: 0 },
			exports: { type: Number, default: 0 },
		},
		chatPeakMax: { type: Number, default: 0 },
		chatPeakByRoom: {
			type: Map,
			of: Number,
			default: () => new Map(),
		},
		adminsPeak: { type: Number, default: 1 },
		lastUpdatedAt: { type: Date, default: Date.now },
	},
	{
		timestamps: true,
	},
);

usageMonthlySchema.index(
	{ organizationId: 1, periodKey: 1 },
	{ unique: true, name: 'unique_usage_monthly_org_period' },
);

module.exports = mongoose.model('UsageMonthly', usageMonthlySchema);
