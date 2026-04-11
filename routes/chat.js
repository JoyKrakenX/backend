/** @format */

const express = require('express');

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const { validateChatSendMessage } = require('../middlewares/requestValidators');
const chatController = require('../controllers/chatController');

const router = express.Router();

router.get('/:surveyId/messages', auth, chatController.getChatMessages);

router.post(
	'/:surveyId/messages',
	sensitiveRateLimit,
	auth,
	validateChatSendMessage,
	chatController.sendMessage,
);

router.post(
	'/messages/:messageId/reaction',
	sensitiveRateLimit,
	auth,
	chatController.toggleMessageLike,
);

router.delete(
	'/messages/:messageId',
	sensitiveRateLimit,
	auth,
	chatController.deleteMessage,
);

router.post(
	'/messages/:messageId/mute',
	sensitiveRateLimit,
	auth,
	chatController.muteMessageAuthor,
);

router.post(
	'/messages/:messageId/ban',
	sensitiveRateLimit,
	auth,
	chatController.banMessageAuthor,
);

router.get('/:surveyId/stats', auth, chatController.getChatStats);

module.exports = router;
