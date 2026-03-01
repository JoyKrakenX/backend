/** @format */

const User = require('../models/User');
const { normalizeEmail, isSupportAdminEmail } = require('../utils/supportAdminAllowlist');
const { isBillingExemptEmail } = require('../services/superAdminService');

module.exports = async (req, res, next) => {
	try {
		if (!req.userId) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		let email = normalizeEmail(req.userEmail || req.user?.email || '');
		if (!email) {
			const dbUser = await User.findById(req.userId).select('email').lean();
			email = normalizeEmail(dbUser?.email);
		}

		if (isBillingExemptEmail(email) || !isSupportAdminEmail(email)) {
			return res.status(403).json({
				message: 'Acces reserve a l administrateur support autorise.',
			});
		}

		req.userEmail = email;
		return next();
	} catch (error) {
		console.error('requireSupportAdminEmail:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};