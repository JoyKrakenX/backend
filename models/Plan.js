/** @format */

const mongoose = require('mongoose');

const nullableNumberField = {
	type: Number,
	default: null,
	validate: {
		validator(value) {
			return value === null || (Number.isFinite(value) && value >= 0);
		},
		message: 'La valeur doit etre nulle ou un nombre positif.',
	},
};

const planSchema = new mongoose.Schema(
	{
		code: { type: String, required: true, unique: true, index: true },
		displayName: { type: String, required: true },
		priceMonthlyUsd: nullableNumberField,
		currency: { type: String, default: 'USD' },
		quotas: {
			votes: nullableNumberField,
			chatConcurrent: nullableNumberField,
			surveys: nullableNumberField,
			admins: nullableNumberField,
			exports: nullableNumberField,
		},
		overage: {
			voteUnitUsd: { type: Number, default: 0 },
			chatTierSize: { type: Number, default: 500 },
			chatTierUsd: { type: Number, default: 40 },
			adminUnitUsd: { type: Number, default: 8 },
		},
		features: {
			chatEnabled: { type: Boolean, default: true },
			exportsEnabled: { type: Boolean, default: true },
			privateSurveysEnabled: { type: Boolean, default: true },
		},
		isPublic: { type: Boolean, default: true },
		trialEligible: { type: Boolean, default: false },
	},
	{
		timestamps: true,
	},
);

module.exports = mongoose.model('Plan', planSchema);
