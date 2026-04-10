const test = require('node:test');
const assert = require('node:assert/strict');

const {
	mergePlanQuotasWithAddons,
	normalizeAddonQuantity,
	canPurchaseAddon,
} = require('../../services/billing/addonService');

test('mergePlanQuotasWithAddons extends finite quotas with active add-ons', () => {
	const merged = mergePlanQuotasWithAddons(
		{ votes: 15000, chatConcurrent: 200, surveys: null, admins: 3, exports: 10 },
		[
			{ code: 'RESPONSE_PACK_50K', quantity: 2 },
			{ code: 'ADMIN_PACK_5', quantity: 1 },
			{ code: 'LIVE_EVENT_BOOST_72H', quantity: 1 },
		],
	);

	assert.equal(merged.votes, 115000);
	assert.equal(merged.chatConcurrent, 1200);
	assert.equal(merged.admins, 8);
	assert.equal(merged.surveys, null);
	assert.equal(merged.exports, 10);
});

test('normalizeAddonQuantity clamps quantity to addon checkout caps', () => {
	assert.equal(normalizeAddonQuantity('RESPONSE_PACK_50K', 50), 10);
	assert.equal(normalizeAddonQuantity('LIVE_EVENT_BOOST_72H', 9), 5);
	assert.equal(normalizeAddonQuantity('ADMIN_PACK_5', 0), 1);
	assert.equal(normalizeAddonQuantity('UNKNOWN', 1), null);
});

test('canPurchaseAddon only allows public add-ons on eligible plans', () => {
	assert.equal(canPurchaseAddon({ addonCode: 'ADMIN_PACK_5', effectivePlanCode: 'STARTER' }).ok, true);
	assert.equal(canPurchaseAddon({ addonCode: 'ADMIN_PACK_5', effectivePlanCode: 'FREE' }).ok, false);
});
