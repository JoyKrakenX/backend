const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildRestrictionPayload,
	createChatModerationError,
	CHAT_RESTRICTION_STATES,
	CHAT_ERROR_CODES,
	__test__,
} = require('../services/chatModerationService');

const { validateModerationTarget } = __test__;

test('buildRestrictionPayload marks active mute as muted', () => {
	const now = new Date('2026-04-10T10:00:00.000Z');
	const restriction = {
		muteUntil: new Date('2026-04-10T10:10:00.000Z'),
		bannedAt: null,
	};

	assert.deepEqual(buildRestrictionPayload(restriction, now), {
		state: CHAT_RESTRICTION_STATES.MUTED,
		muteUntil: '2026-04-10T10:10:00.000Z',
	});
});

test('buildRestrictionPayload clears expired mute without cron', () => {
	const now = new Date('2026-04-10T10:15:00.000Z');
	const restriction = {
		muteUntil: new Date('2026-04-10T10:10:00.000Z'),
		bannedAt: null,
	};

	assert.deepEqual(buildRestrictionPayload(restriction, now), {
		state: CHAT_RESTRICTION_STATES.NONE,
		muteUntil: null,
	});
});

test('buildRestrictionPayload gives ban priority over mute', () => {
	const now = new Date('2026-04-10T10:05:00.000Z');
	const restriction = {
		muteUntil: new Date('2026-04-10T10:10:00.000Z'),
		bannedAt: new Date('2026-04-10T10:01:00.000Z'),
	};

	assert.deepEqual(buildRestrictionPayload(restriction, now), {
		state: CHAT_RESTRICTION_STATES.BANNED,
		muteUntil: null,
	});
});

test('validateModerationTarget rejects self moderation attempts', () => {
	assert.throws(
		() =>
			validateModerationTarget({
				chatMessage: { userId: '507f1f77bcf86cd799439011', isSystemMessage: false },
				survey: { isClosed: false },
				protectedTargetUserIds: new Set(),
				actorUserId: '507f1f77bcf86cd799439011',
				canModerate: true,
			}),
		(error) =>
			error.status === 403 &&
			error.code === CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
	);
});

test('validateModerationTarget rejects protected owner/admin targets', () => {
	assert.throws(
		() =>
			validateModerationTarget({
				chatMessage: { userId: '507f1f77bcf86cd799439012', isSystemMessage: false },
				survey: { isClosed: false },
				protectedTargetUserIds: new Set(['507f1f77bcf86cd799439012']),
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: true,
			}),
		(error) =>
			error.status === 403 &&
			error.code === CHAT_ERROR_CODES.TARGET_PROTECTED,
	);
});

test('validateModerationTarget rejects sanctions on archived chats', () => {
	assert.throws(
		() =>
			validateModerationTarget({
				chatMessage: { userId: '507f1f77bcf86cd799439013', isSystemMessage: false },
				survey: { isClosed: true },
				protectedTargetUserIds: new Set(),
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: true,
				requireOpenSurvey: true,
			}),
		(error) =>
			error.status === 403 &&
			error.code === CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
	);
});

test('validateModerationTarget rejects system messages and non moderators', () => {
	assert.throws(
		() =>
			validateModerationTarget({
				chatMessage: { userId: '507f1f77bcf86cd799439014', isSystemMessage: true },
				survey: { isClosed: false },
				protectedTargetUserIds: new Set(),
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: true,
			}),
		(error) =>
			error.status === 403 &&
			error.code === CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
	);

	assert.throws(
		() =>
			validateModerationTarget({
				chatMessage: { userId: '507f1f77bcf86cd799439014', isSystemMessage: false },
				survey: { isClosed: false },
				protectedTargetUserIds: new Set(),
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: false,
			}),
		(error) =>
			error.status === 403 &&
			error.code === CHAT_ERROR_CODES.MODERATION_FORBIDDEN,
	);
});

test('createChatModerationError keeps stable HTTP metadata', () => {
	const error = createChatModerationError(
		403,
		CHAT_ERROR_CODES.MUTED,
		'Muted for test',
	);

	assert.equal(error.status, 403);
	assert.equal(error.code, CHAT_ERROR_CODES.MUTED);
	assert.equal(error.message, 'Muted for test');
});
