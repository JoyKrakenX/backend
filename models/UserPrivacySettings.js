/** @format */

const mongoose = require('mongoose');

const userPrivacySettingsSchema = new mongoose.Schema(
	{
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			unique: true,
			index: true,
		},
		publicProfile: {
			type: Boolean,
			default: true,
		},
		analyticsOptIn: {
			type: Boolean,
			default: true,
		},
		emailNotifications: {
			type: Boolean,
			default: true,
		},
	},
	{
		timestamps: true,
	},
);

module.exports = mongoose.model(
	'UserPrivacySettings',
	userPrivacySettingsSchema,
);
