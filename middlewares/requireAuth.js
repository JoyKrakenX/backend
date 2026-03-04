/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

const extractToken = (req) => {
	const authHeader = req.headers.authorization || req.headers.Authorization;
	if (authHeader && authHeader.startsWith('Bearer ')) {
		return authHeader.slice(7).trim();
	}

	return (
		req.headers['x-access-token'] ||
		req.headers['x-auth-token'] ||
		req.query?.token ||
		null
	);
};

module.exports = (req, res, next) => {
	try {
		const token = extractToken(req);
		if (!token) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) {
			return res.status(401).json({ message: 'Token invalide.' });
		}
		const decodedEmail = decoded.email || null;
		const effectiveRole = resolveEffectiveRoleByEmail({
			email: decodedEmail,
			fallbackRole: decoded.role || 'user',
		});

		req.user = {
			id: String(decoded.id),
			pseudo: decoded.pseudo || null,
			email: decodedEmail,
			role: effectiveRole,
		};

		req.userId = mongoose.Types.ObjectId.createFromHexString(String(decoded.id));
		req.userPseudo = decoded.pseudo || null;
		req.userRole = effectiveRole;
		req.userEmail = decodedEmail;

		return next();
	} catch (error) {
		return res.status(401).json({ message: 'Session invalide ou expirée.' });
	}
};
