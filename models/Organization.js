/** @format */

const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
	{
		name: { type: String, required: true, trim: true },
		slug: { type: String, unique: true, sparse: true, trim: true },
		ownerUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		status: {
			type: String,
			enum: ['active', 'suspended', 'archived'],
			default: 'active',
			index: true,
		},
		timezone: { type: String, default: 'UTC' },
		currency: { type: String, default: 'USD' },
		paymentCurrency: {
			type: String,
			enum: ['XOF', 'GNF'],
			default: 'XOF',
			index: true,
		},
	},
	{
		timestamps: true,
	},
);

module.exports = mongoose.model('Organization', organizationSchema);
