const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateOverage } = require('../../services/billing/invoiceService');

test('calculateOverage ignores unlimited quotas represented by null', () => {
	const result = calculateOverage({
		plan: {
			quotas: {
				votes: null,
				chatConcurrent: null,
				admins: null,
			},
		},
		usage: {
			counts: {
				votes: 999999,
			},
			chatPeakMax: 7777,
			adminsPeak: 99,
		},
		adminsCount: 99,
	});

	assert.equal(result.votesUsd, 0);
	assert.equal(result.chatUsd, 0);
	assert.equal(result.adminsUsd, 0);
	assert.equal(result.totalUsd, 0);
	assert.equal(result.details.extraVotes, 0);
	assert.equal(result.details.extraChat, 0);
	assert.equal(result.details.extraAdmins, 0);
});
