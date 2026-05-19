const test = require('node:test');
const assert = require('node:assert/strict');

const billingController = require('../../controllers/billingController');

const { buildMetrics } = billingController.__test;

test('buildMetrics preserves unlimited quotas as null in summary payload', () => {
	const metrics = buildMetrics({
		plan: {
			quotas: {
				surveys: null,
				exports: null,
				votes: null,
				chatConcurrent: null,
				admins: null,
			},
		},
		usage: {
			counts: {
				surveys: 999,
				exports: 999,
				votes: 10,
			},
			chatPeakMax: 3,
		},
		adminsCount: 2,
	});

	const surveysMetric = metrics.find((entry) => entry.key === 'surveys');
	const exportsMetric = metrics.find((entry) => entry.key === 'exports');
	const votesMetric = metrics.find((entry) => entry.key === 'votes');
	const chatMetric = metrics.find((entry) => entry.key === 'chatConcurrent');
	const adminsMetric = metrics.find((entry) => entry.key === 'admins');

	assert.ok(surveysMetric);
	assert.ok(exportsMetric);
	assert.ok(votesMetric);
	assert.ok(chatMetric);
	assert.ok(adminsMetric);
	assert.equal(surveysMetric.quota, null);
	assert.equal(exportsMetric.quota, null);
	assert.equal(votesMetric.quota, null);
	assert.equal(chatMetric.quota, null);
	assert.equal(adminsMetric.quota, null);
	assert.equal(surveysMetric.percent, null);
	assert.equal(exportsMetric.percent, null);
	assert.equal(votesMetric.percent, null);
	assert.equal(chatMetric.percent, null);
	assert.equal(adminsMetric.percent, null);
});
