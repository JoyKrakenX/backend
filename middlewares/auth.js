/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { isBillingExemptEmail } = require('../services/superAdminService');

module.exports = (req, res, next) => {
	try {
		const header = req.headers.authorization || req.headers.Authorization;
		const bearerToken =
			header && header.startsWith('Bearer ') ? header.split(' ')[1] : null;
		const fallbackToken =
			req.headers['x-access-token'] ||
			req.headers['x-auth-token'] ||
			req.query?.token ||
			null;
		const token = bearerToken || fallbackToken;

		if (!token) return res.status(401).json({ message: 'Token non fourni.' });

		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) {
			return res.status(401).json({ message: 'Token invalide.' });
		}
		const decodedEmail = decoded.email || null;
		const effectiveRole = isBillingExemptEmail(decodedEmail) ? 'user' : (decoded.role || 'user');
		req.userId = mongoose.Types.ObjectId.createFromHexString(String(decoded.id));
		req.userPseudo = decoded.pseudo;
		req.userRole = effectiveRole;
		req.userEmail = decodedEmail;
		req.user = {
			id: String(decoded.id),
			pseudo: decoded.pseudo || null,
			email: decodedEmail,
			role: effectiveRole,
		};
		next();
	} catch (err) {
		return res.status(401).json({ message: 'Token introuvable.' });
	}
};
