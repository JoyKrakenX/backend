/** @format */

// Update user pseudo
exports.updatePseudo = async (req, res, next) => {
	try {
		const userId = req.userId;
		const { pseudo } = req.body;
		if (
			!pseudo ||
			typeof pseudo !== 'string' ||
			pseudo.length < 3 ||
			pseudo.length > 32
		) {
			return res.status(400).json({ message: 'Pseudo invalide.' });
		}
		// Check uniqueness
		const existing = await User.findOne({ pseudo });
		if (existing && existing._id.toString() !== userId.toString()) {
			return res.status(409).json({ message: 'Ce pseudo est déjà utilisé.' });
		}
		// Update
		const user = await User.findByIdAndUpdate(
			userId,
			{ pseudo },
			{ new: true },
		);
		if (!user)
			return res.status(404).json({ message: 'Utilisateur introuvable.' });
		return res.json({ pseudo: user.pseudo });
	} catch (err) {
		console.error('Erreur updatePseudo:', err);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
/** @format */

const jwt = require('jsonwebtoken');

const User = require('../models/User');

exports.completeProfile = async (req, res, next) => {
	try {
		const { tempToken, pseudo, birthdate, gender } = req.body;

		if (!tempToken)
			return res.status(400).json({ message: 'Token non fourni' });
		if (!pseudo || !birthdate || !gender)
			return res.status(400).json({ message: 'Tous les champs sont requis.' });

		let decoded;
		try {
			decoded = jwt.verify(tempToken, process.env.JWT_TEMP_SECRET);
		} catch (err) {
			return res
				.status(401)
				.json({ message: 'Token temporaire invalide ou expiré.' });
		}

		const user =
			(await User.findById(decoded.userId)) ||
			(await User.findOne({ googleId: decoded.googleId }));
		if (!user)
			return res.status(404).json({ message: 'Utilisateur introuvable.' });

		const exist = await User.findOne({ pseudo: pseudo.trim() });
		if (exist)
			return res.status(409).json({ message: 'Ce pseudo est déjà utilisé.' });

		user.pseudo = pseudo.trim();
		user.birthdate = birthdate;
		user.gender = gender;
		await user.save();

		const token = jwt.sign(
			{
				id: user._id,
				pseudo: user.pseudo,
				email: user.email,
			},
			process.env.JWT_SECRET,
			{ expiresIn: process.env.JWT_EXPIRES_IN },
		);
		return res.status(200).json({
			message: 'Profil complété avec succes.',
			token,
			user: { id: user._id, pseudo: user.pseudo, email: user.email },
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: 'Erreur interne du serveur.' });
	}
};
