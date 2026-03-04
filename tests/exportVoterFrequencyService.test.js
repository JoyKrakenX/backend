const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildUnavailableRegularVoterInsight,
	normalizeRegularVoterThreshold,
} = require('../services/exportVoterFrequencyService');

test('normalizeRegularVoterThreshold keeps default fallback for invalid values', () => {
	assert.equal(normalizeRegularVoterThreshold(undefined), 3);
	assert.equal(normalizeRegularVoterThreshold(''), 3);
	assert.equal(normalizeRegularVoterThreshold('abc'), 3);
	assert.equal(normalizeRegularVoterThreshold('-2'), 3);
	assert.equal(normalizeRegularVoterThreshold('0'), 3);
});

test('normalizeRegularVoterThreshold accepts valid positive integer values', () => {
	assert.equal(normalizeRegularVoterThreshold(1), 1);
	assert.equal(normalizeRegularVoterThreshold('3'), 3);
	assert.equal(normalizeRegularVoterThreshold('8'), 8);
});

test('buildUnavailableRegularVoterInsight is anonymous and non-blocking by contract', () => {
	const insight = buildUnavailableRegularVoterInsight({ threshold: 5 });
	assert.equal(insight.status, 'unavailable');
	assert.equal(insight.scope, 'creator_surveys');
	assert.equal(insight.population, 'current_survey_participants');
	assert.equal(insight.includeCurrentSurvey, true);
	assert.equal(insight.thresholdMinSurveys, 5);
	assert.equal(insight.participantCount, null);
	assert.equal(insight.regularVoterCount, null);
	assert.equal(insight.regularVoterRate, null);
	assert.ok(typeof insight.generatedAt === 'string' && insight.generatedAt.length > 0);
});
