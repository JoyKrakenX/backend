const assert = require('node:assert/strict');

const {
	buildAdminAnalyticsSnapshot,
	normalizeScanSource,
} = require('../services/surveyAnalyticsService');

const baseDate = new Date('2026-05-18T20:00:00.000Z');
const minutesAfter = (minutes) => new Date(baseDate.getTime() + minutes * 60000);

const survey = {
	_id: 'survey-a',
	createdAt: baseDate,
	organizationId: 'org-a',
	userId: 'owner-a',
};

const currentOpinions = [
	{
		_id: 'op-1',
		userId: 'u1',
		answer: true,
		createdAt: minutesAfter(1),
		adminProfile: { age: 22, gender: 'femme' },
		scanId: 'scan-1',
	},
	{
		_id: 'op-2',
		userId: 'u2',
		answer: false,
		createdAt: minutesAfter(2),
		adminProfile: { age: 34, gender: 'homme' },
		scanId: 'scan-2',
	},
	{
		_id: 'op-3',
		userId: 'u1',
		answer: true,
		createdAt: minutesAfter(3),
		adminProfile: { age: 22, gender: 'femme' },
	},
];

const previousOpinions = [
	{ userId: 'u1', createdAt: minutesAfter(-60) },
	{ userId: 'u3', createdAt: minutesAfter(-59) },
];

const scanEvents = [
	{
		type: 'scan',
		scanId: 'scan-1',
		source: 'tv',
		countryCode: 'FR',
		countryName: 'France',
		createdAt: baseDate,
	},
	{
		type: 'scan',
		scanId: 'scan-2',
		source: 'social',
		countryCode: 'CI',
		countryName: "Cote d'Ivoire",
		createdAt: minutesAfter(1),
	},
	{
		type: 'scan',
		scanId: 'scan-3',
		source: 'direct',
		countryCode: 'FR',
		countryName: 'France',
		createdAt: minutesAfter(2),
	},
];

const chatMessages = [
	{ _id: 'm1', userId: 'u1', createdAt: minutesAfter(2), message: 'Salut' },
	{ _id: 'm2', userId: 'u4', createdAt: minutesAfter(2), message: 'Yo' },
	{ _id: 'm3', userId: 'u4', createdAt: minutesAfter(4), message: 'Encore' },
];

const previousChatMessages = [{ userId: 'u1' }, { userId: 'u5' }];

const emojiEvents = [
	{ type: 'chat_emoji', metadata: { emoji: '🔥' }, createdAt: minutesAfter(2) },
	{ type: 'chat_emoji', metadata: { emoji: '🔥' }, createdAt: minutesAfter(2) },
	{ type: 'chat_emoji', metadata: { emoji: '👏' }, createdAt: minutesAfter(4) },
];

assert.equal(normalizeScanSource('facebook'), 'social');
assert.equal(normalizeScanSource('', 'https://community-web.com/survey.html'), 'direct');
assert.equal(normalizeScanSource('', 'https://twitter.com/post'), 'social');
assert.equal(normalizeScanSource('replay'), 'direct');

const snapshot = buildAdminAnalyticsSnapshot({
	survey,
	type: 'binary',
	currentOpinions,
	previousOpinions,
	scanEvents,
	chatMessages,
	previousChatMessages,
	emojiEvents,
	activeUsersCount: 2,
	now: minutesAfter(5),
});

assert.equal(snapshot.acquisition.totalScans, 3);
assert.deepEqual(snapshot.acquisition.topCountries.slice(0, 2), [
	{ countryCode: 'FR', countryName: 'France', count: 2 },
	{ countryCode: 'CI', countryName: "Cote d'Ivoire", count: 1 },
]);
assert.equal(snapshot.acquisition.sources.tv, 1);
assert.equal(snapshot.acquisition.sources.social, 1);
assert.equal(snapshot.acquisition.sources.direct, 1);
assert.equal('replay' in snapshot.acquisition.sources, false);

assert.equal(snapshot.conversion.votersRealtime, 3);
assert.equal(snapshot.conversion.scanToVoteRate, 67);
assert.equal(snapshot.conversion.averageScanToVoteSeconds, 60);
assert.equal(snapshot.conversion.returningVotersFromPreviousSurvey, 1);
assert.equal(snapshot.conversion.previousSurveyVoters, 2);

assert.equal(snapshot.opinions.timeline.length, 3);
assert.equal(snapshot.opinions.firstLeaderChangeAt, minutesAfter(1).toISOString());
assert.equal(snapshot.opinions.voteVelocityPerMinute > 0, true);

assert.equal(snapshot.chat.totalMessages, 3);
assert.equal(snapshot.chat.activeParticipants, 2);
assert.equal(snapshot.chat.activeUsersRealtime, 2);
assert.equal(snapshot.chat.voterToChatParticipantRate, 33);
assert.equal(snapshot.chat.returningChatParticipants, 1);
assert.equal(snapshot.chat.topEmojiPeaks[0].emoji, '🔥');

assert.equal(snapshot.profile.topAgeBand.label, '18-24');
assert.equal(snapshot.profile.dominantGender.label, 'femme');
assert.equal(snapshot.profile.dominantCountry.countryCode, 'FR');

assert.equal(snapshot.retention.returningVoters, 1);
assert.equal(snapshot.retention.returningChatParticipants, 1);
assert.equal(snapshot.retention.voterRetentionRate, 50);

assert.equal(snapshot.reliability.level, 'weak');
assert.match(snapshot.reliability.note, /participante active/i);

console.log('survey analytics service ok');
