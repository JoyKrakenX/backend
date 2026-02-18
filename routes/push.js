/** @format */

const express = require('express');
const requireAuth = require('../middlewares/requireAuth');
const supportPushController = require('../controllers/supportPushController');

const router = express.Router();

router.get('/public-key', requireAuth, supportPushController.getPublicKey);
router.post('/subscribe', requireAuth, supportPushController.subscribe);
router.post('/unsubscribe', requireAuth, supportPushController.unsubscribe);
router.post('/unsubscribe-all', requireAuth, supportPushController.unsubscribeAll);
router.get('/subscriptions', requireAuth, supportPushController.listSubscriptions);

module.exports = router;
