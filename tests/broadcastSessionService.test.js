const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const {
	parseOutputs,
	normalizeMode,
	buildBroadcastUrls,
	signBroadcastSessionToken,
} = require('../services/broadcastSessionService');

test('parseOutputs keeps only valid unique outputs', () => {
	assert.deepEqual(parseOutputs(['overlay', 'feed', 'overlay', 'invalid']), ['overlay', 'feed']);
	assert.deepEqual(parseOutputs([]), ['overlay', 'feed']);
});

test('normalizeMode falls back to combined on invalid values', () => {
	assert.equal(normalizeMode('results'), 'results');
	assert.equal(normalizeMode('unknown'), 'combined');
});

test('buildBroadcastUrls returns signed overlay and feed endpoints', () => {
	const urls = buildBroadcastUrls({
		req: {
			protocol: 'https',
			headers: {},
			get(name) {
				if (name === 'host') return 'community.example.com';
				return '';
			},
		},
		token: 'signed-token',
		session: {
			mode: 'combined',
			outputs: ['overlay', 'feed'],
		},
	});

	assert.equal(urls.overlay, 'https://community.example.com/overlay-combined.html?token=signed-token');
	assert.equal(urls.feed, 'https://community.example.com/api/broadcast/feed/combined?token=signed-token');
	assert.equal(urls.bootstrap, 'https://community.example.com/api/broadcast/bootstrap?token=signed-token');
});

test('signBroadcastSessionToken embeds broadcast claims', () => {
	const previousSecret = process.env.JWT_SECRET;
	process.env.JWT_SECRET = 'test-broadcast-secret';
	try {
		const token = signBroadcastSessionToken({
			_id: 'session-1',
			surveyId: 'survey-1',
			mode: 'chat',
			outputs: ['overlay'],
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		});
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		assert.equal(decoded.kind, 'broadcast_session');
		assert.equal(decoded.sessionId, 'session-1');
		assert.equal(decoded.surveyId, 'survey-1');
		assert.equal(decoded.mode, 'chat');
		assert.deepEqual(decoded.outputs, ['overlay']);
	} finally {
		if (previousSecret === undefined) delete process.env.JWT_SECRET;
		else process.env.JWT_SECRET = previousSecret;
	}
});
