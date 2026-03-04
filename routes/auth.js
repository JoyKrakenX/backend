/** @format */

const express = require('express');

const router = express.Router();

const passport = require('passport');

require('../config/passport');

const auth = require( '../middlewares/auth' );
const User = require('../models/User');
const { buildFrontendUrl } = require('../utils/publicUrls');
const {
	ensurePersonalOrganizationForUser,
} = require('../services/organizationService');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

router.get(
	'/google',
	passport.authenticate('google', { scope: ['profile', 'email'] }),
);

router.get(
	'/google/callback',
	passport.authenticate('google', { session: false }),
	(req, res, next) => {
		const { tempToken, token, finalized } = req.user;

		if (!finalized) {
			return res.redirect(
				buildFrontendUrl(req, 'complete-profile.html', { token: tempToken }),
			);
		}

		if (finalized) {
			return res.redirect(
				buildFrontendUrl(req, 'browse-surveys.html', { token }),
			);
		}
	},
);


router.get('/auth/failure', (req, res, next) => {
	res.status(401).json({ message: "Echec de l'authentification" });
});

// Update user pseudo
const userController = require('../controllers/authController');
router.put('/pseudo', auth, userController.updatePseudo);

router.get('/me', auth, async (req, res, next) => {
	try {
		await ensurePersonalOrganizationForUser({ _id: req.userId });
		const user = await User.findById(req.userId).select(
			'_id pseudo email role name picture defaultOrganizationId',
		);
		if (!user) {
			return res.status(404).json({ message: 'Utilisateur introuvable.' });
		}

		return res.status(200).json({
			userId: user._id.toString(),
			pseudo: user.pseudo,
			email: user.email,
			name: user.name || null,
			picture: user.picture || null,
			role: resolveEffectiveRoleByEmail({
				email: user.email,
				fallbackRole: user.role || 'user',
			}),
			defaultOrganizationId: user.defaultOrganizationId || null,
		});
	} catch (err) {
		console.error('Erreur /api/auth/me:', err);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
});

module.exports = router;
