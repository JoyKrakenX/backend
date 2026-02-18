/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const passport = require('passport');
const mongoose = require('mongoose');
const cors = require('cors');

// ---------------------------
// Routes
// ---------------------------
const authRoutes = require('./routes/auth');
const completeRoutes = require('./routes/complete');
const surveyRoutes = require('./routes/survey');
const opinionRoutes = require('./routes/opinion');
const qrRoutes = require('./routes/qrcode');
const survey_2_Routes = require('./routes/survey_2');
const allSurveysRoutes = require('./routes/allSurveys');
const mySurveysRoutes = require('./routes/mySurveys');
const opinion_2_Routes = require('./routes/opinion_2');
const surveyFlashRoutes = require('./routes/surveyFlash');
const surveyFlash2Routes = require('./routes/surveyFlash_2');
const opinionFlashRoutes = require('./routes/opinionFlash');
const opinionFlash2Routes = require('./routes/opinionFlash_2');
const chatRoutes = require('./routes/chat');
const newsletterRoutes = require('./routes/newsletter');
const supportRoutes = require('./routes/support');
const supportChatRoutes = require('./routes/supportChat');
const pushRoutes = require('./routes/push');
const publicRoutes = require('./routes/public');
const privacySettingsRoutes = require('./routes/privacySettings');

const app = express();

// ---------------------------
// CORS
// ---------------------------
app.use(
	cors({
		origin: '*', // pour dev, tu peux restreindre à ton frontend en local ou ngrok
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowedHeaders: [
			'Origin',
			'X-Requested-With',
			'Content',
			'Accept',
			'Content-Type',
			'Authorization',
		],
	}),
);

// ---------------------------
// Body parser
// ---------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------------------
// Passport
// ---------------------------
app.use(passport.initialize());
require('./config/passport');

// ---------------------------
// MongoDB
// ---------------------------
mongoose
	.connect(process.env.MONGO_URI)
	.then(() => console.log('Connexion à MongoDB réussie !'))
	.catch(() => console.log('Connexion à MongoDB échouée !'));

// ---------------------------
// Routes API
// ---------------------------
app.use('/api/auth', authRoutes);
app.use('/api/auth', completeRoutes);
app.use('/api/survey', surveyRoutes);
app.use('/api/opinion', opinionRoutes);
app.use('/api/qrcode', qrRoutes);
app.use('/api/survey_2', survey_2_Routes);
app.use('/api/all-surveys', allSurveysRoutes);
app.use('/api/my-surveys', mySurveysRoutes);
app.use('/api/opinion_2', opinion_2_Routes);
app.use('/api/survey-flash', surveyFlashRoutes);
app.use('/api/survey-2-flash', surveyFlash2Routes);
app.use('/api/opinion-flash', opinionFlashRoutes);
app.use('/api/opinion-2-flash', opinionFlash2Routes);
app.use('/api/chat', chatRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/support/chat', supportChatRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/privacy', privacySettingsRoutes);

// ---------------------------
// Uploads statiques
// ---------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------------------------
// Frontend statique + SPA catch-all
// ---------------------------
// Sert tout le dossier frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Middleware catch-all pour toutes les routes non-API
// Toujours après les routes API
app.use((req, res, next) => {
	if (req.path.startsWith('/api')) return next();
	res.sendFile(path.join(__dirname, '../frontend/browse-surveys.html'));
});

module.exports = app;
