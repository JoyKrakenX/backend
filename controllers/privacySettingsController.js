/** @format */

const mongoose = require('mongoose');
const UserPrivacySettings = require('../models/UserPrivacySettings');

const toBoolean = (value, fallback = true) => {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === 'true') return true;
		if (normalized === 'false') return false;
	}
	return fallback;
};

const buildDefaultPayload = () => ({
	publicProfile: true,
	analyticsOptIn: true,
	emailNotifications: true,
});

exports.getSettings = async (req, res) => {
	try {
		const userId = req.userId;
		if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const existing = await UserPrivacySettings.findOne({ userId }).lean();
		if (!existing) {
			return res.status(200).json(buildDefaultPayload());
		}

		return res.status(200).json({
			publicProfile: Boolean(existing.publicProfile),
			analyticsOptIn: Boolean(existing.analyticsOptIn),
			emailNotifications: Boolean(existing.emailNotifications),
		});
	} catch (error) {
		console.error('privacySettings.getSettings:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.saveSettings = async (req, res) => {
	try {
		const userId = req.userId;
		if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const payload = {
			publicProfile: toBoolean(req.body?.publicProfile, true),
			analyticsOptIn: toBoolean(req.body?.analyticsOptIn, true),
			emailNotifications: toBoolean(req.body?.emailNotifications, true),
		};

		const saved = await UserPrivacySettings.findOneAndUpdate(
			{ userId },
			{
				$set: payload,
				$setOnInsert: { userId },
			},
			{
				new: true,
				upsert: true,
			},
		).lean();

		return res.status(200).json({
			publicProfile: Boolean(saved.publicProfile),
			analyticsOptIn: Boolean(saved.analyticsOptIn),
			emailNotifications: Boolean(saved.emailNotifications),
			updatedAt: saved.updatedAt,
		});
	} catch (error) {
		console.error('privacySettings.saveSettings:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
