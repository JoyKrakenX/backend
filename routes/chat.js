/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const { validateChatSendMessage } = require('../middlewares/requestValidators');
const chatController = require('../controllers/chatController');

// Récupérer les messages d'un sondage
router.get('/:surveyId/messages', auth, chatController.getChatMessages);

// Envoyer un message
router.post(
	'/:surveyId/messages',
	sensitiveRateLimit,
	auth,
	validateChatSendMessage,
	chatController.sendMessage,
);

// Gérer les likes/dislikes des messages
router.post(
	'/messages/:messageId/reaction',
	sensitiveRateLimit,
	auth,
	chatController.toggleMessageLike
);

// Supprimer un message du chat
router.delete(
	'/messages/:messageId',
	sensitiveRateLimit,
	auth,
	chatController.deleteMessage
);

// Récupérer les statistiques du chat
router.get('/:surveyId/stats', auth, chatController.getChatStats);

module.exports = router;
