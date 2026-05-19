/** @format */

const express = require('express');

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const {
	emitAdminAnalyticsUpdate,
	getAdminAnalytics,
	recordScan,
} = require('../services/surveyAnalyticsService');

const router = express.Router();

const normalizeType = (value) => (String(value || '').trim() === 'multiple' ? 'multiple' : 'binary');
const normalizeFlash = (value) =>
	value === true || value === 1 || String(value || '').trim() === '1' || String(value || '').trim().toLowerCase() === 'true';

router.post('/:surveyId/scan', async (req, res) => {
	try {
		const type = normalizeType(req.body?.type || req.query?.type);
		const flash = normalizeFlash(req.body?.flash || req.query?.flash);
		const payload = await recordScan({
			req,
			surveyId: req.params.surveyId,
			type,
			flash,
			source: req.body?.source || req.query?.source,
		});
		emitAdminAnalyticsUpdate(req.app.get('io'), {
			surveyId: req.params.surveyId,
			type,
			flash,
		}).catch(() => {});
		return res.status(201).json(payload);
	} catch (error) {
		return res.status(error.status || 500).json({
			message: error.message || 'Erreur analytics.',
		});
	}
});

router.get('/:surveyId/admin', sensitiveRateLimit, auth, async (req, res) => {
	try {
		const type = normalizeType(req.query?.type);
		const flash = normalizeFlash(req.query?.flash);
		const payload = await getAdminAnalytics({
			surveyId: req.params.surveyId,
			type,
			flash,
			requesterUserId: req.userId,
			io: req.app.get('io'),
		});
		return res.status(200).json(payload);
	} catch (error) {
		return res.status(error.status || 500).json({
			message: error.message || 'Erreur analytics.',
		});
	}
});

module.exports = router;
