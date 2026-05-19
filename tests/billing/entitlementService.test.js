const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeAction } = require('../../services/billing/entitlementService');
const { PLAN_CATALOG, PLAN_CODES } = require('../../services/billing/constants');

const baseInput = {
	organizationId: '65c0f6ab7f2e7c1a4b4d1234',
	userId: '65c0f6ab7f2e7c1a4b4d9876',
	userEmail: 'user@example.com',
	role: 'owner',
	subscription: {
		status: 'active',
		planCode: 'UNLIMITED',
	},
	plan: {
		code: 'UNLIMITED',
		quotas: {
			surveys: null,
			exports: null,
			votes: null,
			chatConcurrent: null,
			admins: null,
		},
		features: {
			exportsEnabled: true,
			chatEnabled: true,
		},
	},
	usage: {
		counts: {
			surveys: 500000,
			exports: 500000,
			votes: 0,
		},
		chatPeakMax: 0,
		adminsPeak: 1,
		adminsCurrent: 1,
	},
};

test('public billing catalog exposes one unlimited organization plan at 45 USD', () => {
	assert.equal(PLAN_CODES.UNLIMITED, 'UNLIMITED');
	assert.equal(PLAN_CATALOG.length, 1);
	assert.equal(PLAN_CATALOG[0].code, PLAN_CODES.UNLIMITED);
	assert.equal(PLAN_CATALOG[0].priceMonthlyUsd, 45);
	assert.equal(PLAN_CATALOG[0].trialEligible, true);
	assert.equal(PLAN_CATALOG[0].quotas.votes, null);
	assert.equal(PLAN_CATALOG[0].quotas.chatConcurrent, null);
	assert.equal(PLAN_CATALOG[0].quotas.surveys, null);
	assert.equal(PLAN_CATALOG[0].quotas.exports, null);
	assert.equal(PLAN_CATALOG[0].quotas.admins, null);
});

test('CREATE_SURVEY is allowed when surveys quota is unlimited (null)', async () => {
	const result = await authorizeAction({
		...baseInput,
		action: 'create_survey',
	});

	assert.equal(result.allowed, true);
	assert.equal(result.code, null);
});

test('EXPORT is allowed when exports quota is unlimited (null)', async () => {
	const result = await authorizeAction({
		...baseInput,
		action: 'export',
	});

	assert.equal(result.allowed, true);
	assert.equal(result.code, null);
});

test('VOTE and JOIN_CHAT are not blocked by legacy volume quotas', async () => {
	const voteResult = await authorizeAction({
		...baseInput,
		action: 'vote',
		usage: {
			...baseInput.usage,
			counts: {
				...baseInput.usage.counts,
				votes: 999999999,
			},
		},
	});
	const chatResult = await authorizeAction({
		...baseInput,
		action: 'join_chat',
		usage: {
			...baseInput.usage,
			chatPeakMax: 999999999,
		},
	});

	assert.equal(voteResult.allowed, true);
	assert.equal(voteResult.code, null);
	assert.equal(chatResult.allowed, true);
	assert.equal(chatResult.code, null);
});
