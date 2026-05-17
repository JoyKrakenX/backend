/** @format */

const ChatMessage = require('../models/ChatMessage');
const {
	buildFreshChatMessagePayload,
} = require('./chatMessagePayloadService');
const { emitBroadcastStatus } = require('./broadcastRealtimeService');

const buildRoomName = (surveyId) => `survey-${String(surveyId)}`;

async function publishSurveyCommentToChat({
	io,
	surveyId,
	surveyModel,
	userId,
	userPseudo,
	userPicture = null,
	message,
} = {}) {
	const safeMessage = String(message || '').trim();
	if (!io || !surveyId || !surveyModel || !userId || !safeMessage) return null;

	const chatMessage = new ChatMessage({
		surveyId,
		surveyModel,
		userId,
		userPseudo: userPseudo || 'Utilisateur',
		message: safeMessage.slice(0, 500),
		isSystemMessage: false,
	});

	await chatMessage.save();

	const payload = buildFreshChatMessagePayload(chatMessage, {
		userId,
		pseudo: userPseudo || 'Utilisateur',
		picture: userPicture || null,
	});

	io.to(buildRoomName(surveyId)).emit('newMessage', payload);
	emitBroadcastStatus(io, surveyId, {
		reason: 'candidate:new',
		sourceType: 'chat_message',
		sourceId: String(chatMessage._id),
	});

	return payload;
}

module.exports = {
	publishSurveyCommentToChat,
};
