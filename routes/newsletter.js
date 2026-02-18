/** @format */

const express = require('express');
const newsletterController = require('../controllers/newsletterController');
const optionalAuth = require('../middlewares/optionalAuth');
const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const rateLimit = require('../middlewares/simpleRateLimit');

const router = express.Router();

router.post(
	'/subscribe',
	rateLimit({ windowMs: 60_000, max: 10, keyPrefix: 'newsletter-subscribe' }),
	optionalAuth,
	newsletterController.subscribe,
);
router.get('/confirm', newsletterController.confirm);
router.post(
	'/unsubscribe',
	rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'newsletter-unsubscribe' }),
	newsletterController.unsubscribe,
);
router.get('/unsubscribe', newsletterController.unsubscribe);
router.get(
	'/admin/export',
	requireAuth,
	requireRole('support', 'admin'),
	newsletterController.adminExport,
);

module.exports = router;
