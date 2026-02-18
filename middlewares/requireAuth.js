/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

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

		req.user = {
			id: String(decoded.id),
			pseudo: decoded.pseudo || null,
			email: decoded.email || null,
			role: decoded.role || 'user',
		};

		req.userId = mongoose.Types.ObjectId.createFromHexString(String(decoded.id));
		req.userPseudo = decoded.pseudo || null;
		req.userRole = decoded.role || 'user';
		req.userEmail = decoded.email || null;

		return next();
	} catch (error) {
		return res.status(401).json({ message: 'Session invalide ou expirée.' });
	}
};

