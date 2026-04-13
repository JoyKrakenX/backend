/** @format */

const express = require('express');

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const broadcastController = require('../controllers/broadcastController');

const router = express.Router();

router.get('/surveys/:id/studio-bootstrap', auth, broadcastController.getStudioBootstrap);
router.get('/surveys/:id/candidates', auth, broadcastController.getCandidates);
router.post('/surveys/:id/cues', sensitiveRateLimit, auth, broadcastController.createCue);
router.patch('/surveys/:id/cues/:cueId', sensitiveRateLimit, auth, broadcastController.updateCue);
router.post('/surveys/:id/sessions', sensitiveRateLimit, auth, broadcastController.createSession);
router.patch(
	'/surveys/:id/sessions/:sessionId/revoke',
	sensitiveRateLimit,
	auth,
	broadcastController.revokeSession,
);
router.patch('/surveys/:id/config', sensitiveRateLimit, auth, broadcastController.updateConfig);

router.get('/bootstrap', broadcastController.getPublicBootstrap);
router.get('/feed/results', broadcastController.getResultsFeed);
router.get('/feed/chat', broadcastController.getChatFeed);
router.get('/feed/combined', broadcastController.getCombinedFeed);

module.exports = router;

