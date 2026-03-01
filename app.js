/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const passport = require('passport');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');

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
const billingRoutes = require('./routes/billing');
const organizationRoutes = require('./routes/organizations');
const exportRoutes = require('./routes/exports');
const { globalRateLimit } = require('./middlewares/securityRateLimit');
const { ensurePlanCatalog } = require('./services/billing/planService');
const { validateProductionSecrets } = require('./utils/securityStartup');

validateProductionSecrets();

const app = express();
app.set('trust proxy', 1);

// ---------------------------
// CORS
// ---------------------------
const parseAllowedOrigins = () =>
	String(process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);

const allowedOrigins = parseAllowedOrigins();

app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin) return callback(null, true);
			if (process.env.NODE_ENV !== 'production') return callback(null, true);
			if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
				return callback(null, true);
			}
			return callback(new Error('CORS origin non autorisee'));
		},
		methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
		allowedHeaders: [
			'Origin',
			'X-Requested-With',
			'Content',
			'Accept',
			'Content-Type',
			'Authorization',
			'X-Organization-Id',
		],
	}),
);

app.use(
	helmet({
		crossOriginResourcePolicy: { policy: 'cross-origin' },
		contentSecurityPolicy: {
			useDefaults: true,
			directives: {
				// Keep CSP strict while allowing external user avatars.
				imgSrc: [
					"'self'",
					'data:',
					'https://ui-avatars.com',
					'https://*.googleusercontent.com',
				],
			},
		},
	}),
);

// ---------------------------
// Body parser
// ---------------------------
app.use(
	express.json({
		limit: '2mb',
		verify: (req, _res, buf) => {
			req.rawBody = Buffer.from(buf);
		},
	}),
);
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
	.then(async () => {
		console.log('Connexion a MongoDB reussie !');
		await ensurePlanCatalog();
	})
	.catch((error) => {
		console.log('Connexion a MongoDB echouee !');
		console.error(error?.message || error);
	});

// ---------------------------
// Routes API
// ---------------------------
app.use('/api', (req, res, next) => {
	if (String(req.path || '').startsWith('/billing/webhooks/')) {
		return next();
	}
	return globalRateLimit(req, res, next);
});
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
app.use('/api/billing', billingRoutes);
app.use('/api/organizations', organizationRoutes);
app.use('/api/exports', exportRoutes);

// ---------------------------
// Uploads statiques
// ---------------------------
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------------------------
// Frontend statique + SPA catch-all
// ---------------------------
app.use(
	express.static(path.join(__dirname, '../frontend'), {
		setHeaders: (res, filePath) => {
			const normalizedPath = String(filePath || '').toLowerCase();
			if (normalizedPath.endsWith('.html')) {
				res.setHeader('Content-Type', 'text/html; charset=utf-8');
				return;
			}
			if (normalizedPath.endsWith('.json')) {
				res.setHeader('Content-Type', 'application/json; charset=utf-8');
			}
		},
	}),
);

app.use((req, res, next) => {
	if (req.path.startsWith('/api')) return next();
	res.setHeader('Content-Type', 'text/html; charset=utf-8');
	res.sendFile(path.join(__dirname, '../frontend/browse-surveys.html'));
});

module.exports = app;

