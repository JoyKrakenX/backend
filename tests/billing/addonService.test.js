const test = require('node:test');
const assert = require('node:assert/strict');

const {
	getPublicAddons,
	getAvailableAddonsForPlan,
	mergePlanQuotasWithAddons,
	normalizeAddonQuantity,
	canPurchaseAddon,
} = require('../../services/billing/addonService');

test('single unlimited billing exposes no public add-ons', () => {
	assert.deepEqual(getPublicAddons(), []);
	assert.deepEqual(getAvailableAddonsForPlan('UNLIMITED'), []);
});

test('mergePlanQuotasWithAddons keeps unlimited quotas untouched without add-ons', () => {
	const merged = mergePlanQuotasWithAddons(
		{ votes: null, chatConcurrent: null, surveys: null, admins: null, exports: null },
		[
			{ code: 'RESPONSE_PACK_50K', quantity: 2 },
			{ code: 'ADMIN_PACK_5', quantity: 1 },
			{ code: 'LIVE_EVENT_BOOST_72H', quantity: 1 },
		],
	);

	assert.equal(merged.votes, null);
	assert.equal(merged.chatConcurrent, null);
	assert.equal(merged.admins, null);
	assert.equal(merged.surveys, null);
	assert.equal(merged.exports, null);
});

test('normalizeAddonQuantity rejects legacy add-ons after catalog removal', () => {
	assert.equal(normalizeAddonQuantity('RESPONSE_PACK_50K', 50), null);
	assert.equal(normalizeAddonQuantity('LIVE_EVENT_BOOST_72H', 9), null);
	assert.equal(normalizeAddonQuantity('ADMIN_PACK_5', 0), null);
	assert.equal(normalizeAddonQuantity('UNKNOWN', 1), null);
});

test('canPurchaseAddon rejects all add-ons in the unlimited-only model', () => {
	assert.equal(canPurchaseAddon({ addonCode: 'ADMIN_PACK_5', effectivePlanCode: 'UNLIMITED' }).ok, false);
	assert.equal(
		canPurchaseAddon({ addonCode: 'ADMIN_PACK_5', effectivePlanCode: 'UNLIMITED' }).reason,
		'ADDON_NOT_FOUND',
	);
});
