const test = require('node:test');
const assert = require('node:assert/strict');

const { authorizeAction } = require('../../services/billing/entitlementService');

const baseInput = {
	organizationId: '65c0f6ab7f2e7c1a4b4d1234',
	userId: '65c0f6ab7f2e7c1a4b4d9876',
	userEmail: 'user@example.com',
	role: 'owner',
	subscription: {
		status: 'active',
		planCode: 'TV_PRO',
	},
	plan: {
		code: 'TV_PRO',
		quotas: {
			surveys: null,
			exports: null,
			votes: 2000000,
			admins: 50,
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
	},
};

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
