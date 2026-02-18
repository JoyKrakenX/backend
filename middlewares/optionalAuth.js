/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

module.exports = (req, _res, next) => {
	try {
		const authHeader = req.headers.authorization || req.headers.Authorization;
		const tokenFromBearer =
			authHeader && authHeader.startsWith('Bearer ')
				? authHeader.slice(7).trim()
				: null;
		const token =
			tokenFromBearer ||
			req.headers['x-access-token'] ||
			req.headers['x-auth-token'] ||
			req.query?.token ||
			null;

		if (!token) return next();

		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) return next();

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
	} catch (_error) {
		return next();
	}
};

