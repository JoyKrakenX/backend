const test = require('node:test');
const assert = require('node:assert/strict');

const {
	scoreCandidate,
	serializeCue,
} = require('../services/broadcastCandidateService');

test('scoreCandidate penalizes duplicate texts from same author', () => {
	const authorCounts = new Map();
	const seenTexts = new Set();
	const now = new Date('2026-04-13T12:00:00.000Z').getTime();

	const first = scoreCandidate({
		candidate: {
			pseudoSnapshot: 'Alice',
			textSnapshot: 'Le public veut plus de debats de fond ce soir.',
			createdAt: '2026-04-13T11:57:00.000Z',
			engagement: { likes: 4, dislikes: 0 },
			sourceType: 'survey_comment',
		},
		authorCounts,
		seenTexts,
		now,
	});

	const second = scoreCandidate({
		candidate: {
			pseudoSnapshot: 'Alice',
			textSnapshot: 'Le public veut plus de debats de fond ce soir.',
			createdAt: '2026-04-13T11:56:00.000Z',
			engagement: { likes: 4, dislikes: 0 },
			sourceType: 'survey_comment',
		},
		authorCounts,
		seenTexts,
		now,
	});

	assert.ok(first > second);
});

test('serializeCue normalizes cue payload for feeds and overlays', () => {
	const cue = serializeCue({
		_id: { toString: () => 'cue-1' },
		sourceType: 'chat_message',
		sourceId: { toString: () => 'message-9' },
		sourceModel: 'ChatMessage',
		surveyId: { toString: () => 'survey-4' },
		surveyType: 'binary_classic',
		pseudoSnapshot: 'Yos',
		textSnapshot: 'On veut plus de faits, moins de bruit.',
		answerSnapshot: '',
		sourceCreatedAt: '2026-04-13T09:10:00.000Z',
		engagementSnapshot: { likes: 2, dislikes: 0, score: 8 },
		visibilityState: 'visible',
		airState: 'featured',
		airOrder: 3,
		broadcastScore: 76,
		approvedAt: '2026-04-13T09:11:00.000Z',
		featuredAt: '2026-04-13T09:12:00.000Z',
		updatedAt: '2026-04-13T09:13:00.000Z',
	});

	assert.equal(cue.id, 'cue-1');
	assert.equal(cue.sourceId, 'message-9');
	assert.equal(cue.featured, true);
	assert.equal(cue.engagement.likes, 2);
	assert.equal(cue.airOrder, 3);
	assert.equal(cue.broadcastScore, 76);
});
