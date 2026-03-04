/** @format */

const passport = require('passport');

const GoogleStrategy = require('passport-google-oauth20').Strategy;

const User = require('../models/User');
const {
	ensurePersonalOrganizationForUser,
} = require('../services/organizationService');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

const jwt = require('jsonwebtoken');

passport.use(
	new GoogleStrategy(
		{
			clientID: process.env.GOOGLE_CLIENT_ID,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET,
			callbackURL: process.env.GOOGLE_REDIRECT_URI,
		},
		async (accessToken, refreshToken, profile, done) => {
			try {
				let user = await User.findOne({ googleId: profile.id });
				const email = profile.emails?.[0]?.value;
				const resolvedRole = resolveEffectiveRoleByEmail({
					email,
					fallbackRole: user?.role || 'user',
				});

				if (!user) {
					user = await User.create({
						googleId: profile.id,
						email,
						name: profile.displayName,
						picture: profile.photos?.[0]?.value,
						role: resolvedRole,
					});
				} else if (user.role !== resolvedRole) {
					user.role = resolvedRole;
					await user.save();
				}

				await ensurePersonalOrganizationForUser(user);

				if (user.pseudo) {
					const effectiveRole = resolveEffectiveRoleByEmail({
						email: user.email,
						fallbackRole: user.role || 'user',
					});
					const token = jwt.sign(
						{
							id: user._id,
							pseudo: user.pseudo,
							email: user.email,
							role: effectiveRole,
						},
						process.env.JWT_SECRET,
						{ expiresIn: process.env.JWT_EXPIRES_IN },
					);

					return done(null, { user, token, finalized: true });
				}

				const tempToken = jwt.sign(
					{
						googleId: user.googleId,
						email: user.email,
						userId: user._id,
						role: resolveEffectiveRoleByEmail({
							email: user.email,
							fallbackRole: user.role || 'user',
						}),
					},
					process.env.JWT_TEMP_SECRET,
					{ expiresIn: process.env.JWT_TEMP_EXPIRES_IN },
				);
				return done(null, { user, tempToken, finalized: false });
			} catch (err) {
				return done(err, null);
			}
		},
	),
);

module.exports = passport;
