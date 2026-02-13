/** @format */

const express = require('express');

const router = express.Router();

const passport = require('passport');

require('../config/passport');

const auth = require('../middlewares/auth');

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
				`http://127.0.0.1:5500/frontend/complete-profile.html?token=${tempToken}`,
			);
		}

		if (finalized) {
			return res.redirect(
				`http://127.0.0.1:5500/frontend/browse-surveys.html?token=${token}`,
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

router.get('/me', auth, (req, res, next) => {
	res.status(200).json({ userId: req.userId, pseudo: req.userPseudo });
});

module.exports = router;
