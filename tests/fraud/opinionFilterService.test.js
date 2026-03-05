/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildStatusFilter,
	getIntegritySnapshotForSurvey,
} = require('../../services/fraud/opinionFilterService');

test('buildStatusFilter returns expected clean/raw/quarantine filters', () => {
	assert.deepEqual(buildStatusFilter('clean'), {
		$or: [
			{ fraudStatus: { $in: ['accepted', 'released'] } },
			{ fraudStatus: { $exists: false } },
			{ fraudStatus: null },
		],
	});
	assert.deepEqual(buildStatusFilter('raw'), {
		$or: [
			{
				fraudStatus: {
					$in: ['accepted', 'quarantined', 'released', 'confirmed_fraud'],
				},
			},
			{ fraudStatus: { $exists: false } },
			{ fraudStatus: null },
		],
	});
	assert.deepEqual(buildStatusFilter('quarantine'), { fraudStatus: 'quarantined' });
});

test('getIntegritySnapshotForSurvey computes confidence and topRiskSignals', async () => {
	const fakeOpinionModel = {
		countDocuments: async (filter = {}) => {
			if (filter?.fraudStatus === 'confirmed_fraud') return 2;
			if (filter?.fraudStatus === 'quarantined') return 3;

			const inStatuses = (filter?.$or || [])
				.map((entry) => entry?.fraudStatus?.$in)
				.find((candidate) => Array.isArray(candidate)) || [];
			if (
				Array.isArray(inStatuses) &&
				inStatuses.includes('accepted') &&
				inStatuses.includes('released') &&
				!inStatuses.includes('quarantined')
			) {
				return 7;
			}
			if (
				Array.isArray(inStatuses) &&
				inStatuses.includes('accepted') &&
				inStatuses.includes('released') &&
				inStatuses.includes('quarantined') &&
				inStatuses.includes('confirmed_fraud')
			) {
				return 12;
			}
			return 0;
		},
		aggregate: async () => [
			{ _id: 'ACCOUNT_TOO_NEW', count: 5 },
			{ _id: 'IP_ACCOUNT_FANOUT_HIGH', count: 4 },
		],
	};

	const snapshot = await getIntegritySnapshotForSurvey(fakeOpinionModel, 'survey-abc');

	assert.equal(snapshot.rawCounts, 12);
	assert.equal(snapshot.cleanCounts, 7);
	assert.equal(snapshot.quarantinedCounts, 3);
	assert.equal(snapshot.confirmedFraudCounts, 2);
	assert.equal(snapshot.confidenceScore, 58);
	assert.deepEqual(snapshot.topRiskSignals, [
		{ code: 'ACCOUNT_TOO_NEW', count: 5 },
		{ code: 'IP_ACCOUNT_FANOUT_HIGH', count: 4 },
	]);
});
