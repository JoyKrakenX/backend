/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const chatController = require('../controllers/chatController');

// Récupérer les messages d'un sondage
router.get('/:surveyId/messages', auth, chatController.getChatMessages);

// Envoyer un message
router.post('/:surveyId/messages', auth, chatController.sendMessage);

// Gérer les likes/dislikes des messages
router.post(
	'/messages/:messageId/reaction',
	auth,
	chatController.toggleMessageLike
);

// Récupérer les statistiques du chat
router.get('/:surveyId/stats', auth, chatController.getChatStats);

module.exports = router;
