/** @format */

const User = require('../models/User');
const {
	normalizeEmail,
	isAnySupportAdminEmail,
} = require('../utils/supportAdminAllowlist');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

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

		const effectiveRole = resolveEffectiveRoleByEmail({
			email,
			fallbackRole: req.userRole || req.user?.role || 'user',
		});
		const isAgentRole = effectiveRole === 'support' || effectiveRole === 'admin';
		if (!isAnySupportAdminEmail(email) || !isAgentRole) {
			return res.status(403).json({
				message: "Accès réservé à l'administrateur support autorisé.",
			});
		}

		req.userEmail = email;
		req.userRole = effectiveRole;
		if (req.user && typeof req.user === 'object') {
			req.user.role = effectiveRole;
		}
		return next();
	} catch (error) {
		console.error('requireSupportAdminEmail:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
