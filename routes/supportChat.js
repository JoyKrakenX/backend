/** @format */

const express = require('express');
const supportChatController = require('../controllers/supportChatController');
const supportPushController = require('../controllers/supportPushController');
const optionalAuth = require('../middlewares/optionalAuth');
const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const requireSupportAdminEmail = require('../middlewares/requireSupportAdminEmail');

const router = express.Router();

router.post('/bootstrap', optionalAuth, supportChatController.bootstrapConversation);
router.get(
	'/conversations',
	requireAuth,
	requireSupportAdminEmail,
	supportChatController.listConversations,
);
router.get(
	'/conversations/:id/messages',
	requireAuth,
	supportChatController.getConversationMessages,
);
router.get(
	'/conversations/agent/queue',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportChatController.listConversations,
);

router.get('/push/public-key', requireAuth, supportPushController.getPublicKey);

router.post(
	'/push/subscribe',
	requireAuth,
	supportPushController.subscribe,
);

router.post(
	'/push/unsubscribe',
	requireAuth,
	supportPushController.unsubscribe,
);

router.post('/push/unsubscribe-all', requireAuth, supportPushController.unsubscribeAll);

router.get('/push/subscriptions', requireAuth, supportPushController.listSubscriptions);

module.exports = router;
