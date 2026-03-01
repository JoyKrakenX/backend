/** @format */

const mongoose = require('mongoose');

const usageEventSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		periodKey: { type: String, required: true, index: true },
		action: {
			type: String,
			enum: ['vote', 'survey_create', 'export', 'chat_peak', 'admin_peak_sync'],
			required: true,
		},
		amount: { type: Number, default: 1 },
		idempotencyKey: { type: String, required: true, unique: true },
		meta: { type: mongoose.Schema.Types.Mixed, default: null },
	},
	{
		timestamps: true,
	},
);

usageEventSchema.index({ organizationId: 1, periodKey: 1, action: 1 });

module.exports = mongoose.model('UsageEvent', usageEventSchema);
