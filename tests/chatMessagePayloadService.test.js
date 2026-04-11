/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildFreshChatMessagePayload,
	formatChatMessagePayload,
	normalizeReplyToInfo,
} = require('../services/chatMessagePayloadService');

test('normalizeReplyToInfo stringifies object ids for reply notifications', () => {
	const replyToInfo = normalizeReplyToInfo({
		messageId: { toString: () => 'message-1' },
		userId: { toString: () => 'user-1' },
		pseudo: 'Alice',
		message: 'Bonjour',
	});

	assert.deepEqual(replyToInfo, {
		messageId: 'message-1',
		userId: 'user-1',
		pseudo: 'Alice',
		message: 'Bonjour',
	});
});

test('formatChatMessagePayload exposes normalized reply payloads', () => {
	const payload = formatChatMessagePayload(
		{
			_id: { toString: () => 'chat-1' },
			userId: {
				_id: { toString: () => 'user-2' },
				picture: null,
			},
			userPseudo: 'Bob',
			message: 'Reponse',
			replyTo: { toString: () => 'chat-0' },
			replyToInfo: {
				messageId: { toString: () => 'chat-0' },
				userId: { toString: () => 'user-1' },
				pseudo: 'Alice',
				message: 'Message original',
			},
			likes: [],
			dislikes: [],
		},
		{ actorUserId: 'user-1' },
	);

	assert.equal(payload.id, 'chat-1');
	assert.equal(payload.replyTo, 'chat-0');
	assert.deepEqual(payload.replyToInfo, {
		messageId: 'chat-0',
		userId: 'user-1',
		pseudo: 'Alice',
		message: 'Message original',
	});
	assert.equal(payload.user.id, 'user-2');
});

test('buildFreshChatMessagePayload builds a renderable payload without populate roundtrip', () => {
	const payload = buildFreshChatMessagePayload(
		{
			toObject() {
				return {
					_id: { toString: () => 'chat-2' },
					userId: { toString: () => 'user-3' },
					userPseudo: 'Charlie',
					message: 'Message direct',
					replyTo: null,
					replyToInfo: null,
					likes: [],
					dislikes: [],
				};
			},
		},
		{
			actorUserId: 'user-3',
			userId: 'user-3',
			pseudo: 'Charlie',
			picture: 'https://example.com/avatar.png',
		},
	);

	assert.equal(payload.id, 'chat-2');
	assert.equal(payload.user.id, 'user-3');
	assert.equal(payload.user.pseudo, 'Charlie');
	assert.equal(payload.user.picture, 'https://example.com/avatar.png');
	assert.equal(payload.userLiked, false);
});
