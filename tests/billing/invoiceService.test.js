const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildRecurringAddonLineItems,
	buildAddonInvoiceDraft,
} = require('../../services/billing/invoiceService');

test('buildRecurringAddonLineItems ignores legacy add-ons after catalog removal', () => {
	const result = buildRecurringAddonLineItems([
		{ code: 'ADMIN_PACK_5', kind: 'recurring', quantity: 2 },
		{ code: 'LIVE_EVENT_BOOST_72H', kind: 'one_time', quantity: 1 },
	]);

	assert.equal(result.lineItems.length, 0);
	assert.equal(result.totalUsd, 0);
});

test('buildAddonInvoiceDraft creates an explicit addon invoice without overage fields', () => {
	const draft = buildAddonInvoiceDraft({
		organizationId: 'org_123',
		subscription: { _id: 'sub_123', planCode: 'GROWTH' },
		addon: {
			code: 'RESPONSE_PACK_50K',
			displayName: 'Response Pack 50k',
			priceUsd: 19,
		},
		quantity: 2,
		periodKey: '2026-04-01_2026-05-01',
	});

	assert.equal(draft.kind, 'addon');
	assert.equal(draft.totalAmountUsd, 38);
	assert.equal(draft.baseAmountUsd, 0);
	assert.equal(draft.lineItems.length, 1);
	assert.equal(draft.lineItems[0].code, 'addon_response_pack_50k');
	assert.equal(draft.lineItems[0].amountUsd, 38);
	assert.deepEqual(draft.metadata, {
		invoiceType: 'addon',
		addonCode: 'RESPONSE_PACK_50K',
		quantity: 2,
	});
	assert.equal('overage' in draft, false);
});
