/** @format */

const mongoose = require('mongoose');

const nullableNumberField = {
	type: Number,
	default: null,
	validate: {
		validator(value) {
			return value === null || (Number.isFinite(value) && value >= 0);
		},
		message: 'La valeur doit être nulle ou un nombre positif.',
	},
};

const planSchema = new mongoose.Schema(
	{
		code: { type: String, required: true, unique: true, index: true },
		displayName: { type: String, required: true },
		priceMonthlyUsd: nullableNumberField,
		priceLabel: { type: String, default: null },
		isQuoteOnly: { type: Boolean, default: false },
		currency: { type: String, default: 'USD' },
		quotas: {
			votes: nullableNumberField,
			chatConcurrent: nullableNumberField,
			surveys: nullableNumberField,
			admins: nullableNumberField,
			exports: nullableNumberField,
		},
		features: {
			chatEnabled: { type: Boolean, default: true },
			exportsEnabled: { type: Boolean, default: true },
			privateSurveysEnabled: { type: Boolean, default: true },
		},
		isPublic: { type: Boolean, default: true },
		isSelectable: { type: Boolean, default: true },
		trialEligible: { type: Boolean, default: false },
		recommended: { type: Boolean, default: false },
		publicOrder: { type: Number, default: 999, index: true },
		audience: { type: String, default: '' },
		description: { type: String, default: '' },
		highlights: { type: [String], default: [] },
		ctaLabel: { type: String, default: '' },
		availableAddonCodes: { type: [String], default: [] },
	},
	{
		timestamps: true,
	},
);

module.exports = mongoose.model('Plan', planSchema);
