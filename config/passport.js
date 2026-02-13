/** @format */

const passport = require('passport');

const GoogleStrategy = require('passport-google-oauth20').Strategy;

const User = require('../models/User');

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

				if (!user) {
					user = await User.create({
						googleId: profile.id,
						email: profile.emails?.[0]?.value,
						name: profile.displayName,
						picture: profile.photos?.[0]?.value,
					});
				}

				if (user.pseudo) {
					const token = jwt.sign(
						{
							id: user._id,
							pseudo: user.pseudo,
							email: user.email,
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
