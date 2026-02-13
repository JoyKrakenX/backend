/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

module.exports = (req, res, next) => {
	try {
		const header = req.headers.authorization;
		if (!header) return res.status(401).json({ message: 'Token non fourni.' });

		const token = header.split(' ')[1];
		const decoded = jwt.verify(token, process.env.JWT_SECRET);

		req.userId = mongoose.Types.ObjectId.createFromHexString(decoded.id);

		req.userPseudo = decoded.pseudo;
		next();
	} catch (err) {
		return res.status(401).json({ message: 'Token introuvable.' });
	}
};
