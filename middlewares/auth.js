/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

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
		req.userId = mongoose.Types.ObjectId.createFromHexString(String(decoded.id));
		req.userPseudo = decoded.pseudo;
		req.userRole = decoded.role || 'user';
		req.userEmail = decoded.email || null;
		req.user = {
			id: String(decoded.id),
			pseudo: decoded.pseudo || null,
			email: decoded.email || null,
			role: decoded.role || 'user',
		};
		next();
	} catch (err) {
		return res.status(401).json({ message: 'Token introuvable.' });
	}
};
