/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

const parseBearerToken = (req) => {
	const header = req.headers.authorization || req.headers.Authorization;
	if (!header || !String(header).startsWith('Bearer ')) return null;
	return String(header).slice(7).trim();
};

const parseJwtToken = (req) =>
	parseBearerToken(req) ||
	String(req.headers['x-access-token'] || '').trim() ||
	String(req.headers['x-auth-token'] || '').trim() ||
	String(req.query?.token || '').trim() ||
	null;

const parseTempToken = (req) =>
	String(req.body?.tempToken || '').trim() ||
	String(req.headers['x-temp-token'] || '').trim() ||
	String(req.query?.tempToken || '').trim() ||
	null;

module.exports = (req, res, next) => {
	const jwtToken = parseJwtToken(req);
	if (jwtToken) {
		try {
			const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET);
			if (decoded?.id && mongoose.Types.ObjectId.isValid(String(decoded.id))) {
				const decodedEmail = decoded.email || null;
				const effectiveRole = resolveEffectiveRoleByEmail({
					email: decodedEmail,
					fallbackRole: decoded.role || 'user',
				});
				req.userId = mongoose.Types.ObjectId.createFromHexString(String(decoded.id));
				req.userPseudo = decoded.pseudo || null;
				req.userRole = effectiveRole;
				req.userEmail = decodedEmail;
				req.user = {
					id: String(decoded.id),
					pseudo: decoded.pseudo || null,
					email: decodedEmail,
					role: effectiveRole,
				};
				req.authMode = 'jwt';
				return next();
			}
		} catch (_error) {}
	}

	const tempToken = parseTempToken(req);
	if (!tempToken) {
		return res.status(401).json({ message: 'Authentification requise.' });
	}

	try {
		const decodedTemp = jwt.verify(tempToken, process.env.JWT_TEMP_SECRET);
		if (!decodedTemp?.userId || !mongoose.Types.ObjectId.isValid(String(decodedTemp.userId))) {
			return res.status(401).json({ message: 'Token temporaire invalide.' });
		}
		req.userId = mongoose.Types.ObjectId.createFromHexString(String(decodedTemp.userId));
		req.userPseudo = decodedTemp.pseudo || null;
		req.userRole = decodedTemp.role || 'user';
		req.userEmail = decodedTemp.email || null;
		req.user = {
			id: String(decodedTemp.userId),
			pseudo: decodedTemp.pseudo || null,
			email: decodedTemp.email || null,
			role: decodedTemp.role || 'user',
		};
		req.authMode = 'temp_profile';
		req.tempTokenPayload = decodedTemp;
		return next();
	} catch (_error) {
		return res.status(401).json({ message: 'Token temporaire invalide ou expire.' });
	}
};

