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
				votes: 100,
				chatConcurrent: 50,
				admins: 5,
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

	assert.ok(surveysMetric);
	assert.ok(exportsMetric);
	assert.equal(surveysMetric.quota, null);
	assert.equal(exportsMetric.quota, null);
	assert.equal(surveysMetric.percent, null);
	assert.equal(exportsMetric.percent, null);
});
