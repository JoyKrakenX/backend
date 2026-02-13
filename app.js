/** @format */

require('dotenv').config();
const express = require('express');
const passport = require('passport');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const completeRoutes = require('./routes/complete');
const surveyRoutes = require('./routes/survey');
const opinionRoutes = require('./routes/opinion');
const qrRoutes = require('./routes/qrcode');
const survey_2_Routes = require('./routes/survey_2');
const allSurveysRoutes = require('./routes/allSurveys');
const mySurveysRoutes = require('./routes/mySurveys');
const opinion_2_Routes = require('./routes/opinion_2');
const chatRoutes = require('./routes/chat');

const app = express();

// ---------------------------
// CORS
// ---------------------------
app.use(
	cors({
		origin: '*', // permet toutes les origines (pour dev). Tu peux mettre 'http://127.0.0.1:5500' si tu veux restreindre
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowedHeaders: [
			'Origin',
			'X-Requested-With',
			'Content',
			'Accept',
			'Content-Type',
			'Authorization',
		],
	})
);

// ---------------------------
// Body parser
// ---------------------------
app.use(express.json());

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
// Routes
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
app.use('/api/chat', chatRoutes);

// ---------------------------
// Upload
// ---------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

module.exports = app;
