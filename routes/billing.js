/** @format */

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const activeOrganization = require('../middlewares/activeOrganization');
const { sensitiveRateLimit, webhookRateLimit } = require('../middlewares/securityRateLimit');
const billingController = require('../controllers/billingController');

const router = express.Router();

router.get('/plans', requireAuth, billingController.getPlans);
router.get('/summary', requireAuth, activeOrganization, billingController.getSummary);
router.get('/invoices', requireAuth, activeOrganization, billingController.getInvoices);
router.get(
	'/checkout-status/:invoiceId',
	requireAuth,
	sensitiveRateLimit,
	activeOrganization,
	billingController.getCheckoutStatus,
);
router.post(
	'/checkout',
	sensitiveRateLimit,
	requireAuth,
	activeOrganization,
	billingController.createCheckout,
);
router.post(
	'/retry-payment',
	sensitiveRateLimit,
	requireAuth,
	activeOrganization,
	billingController.retryPayment,
);

router.post(
	'/webhooks/fedapay',
	webhookRateLimit,
	billingController.fedapayWebhook,
);

module.exports = router;
