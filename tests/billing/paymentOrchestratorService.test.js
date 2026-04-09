const test = require('node:test');
const assert = require('node:assert/strict');

const paymentOrchestratorService = require('../../services/billing/paymentOrchestratorService');

const { getFedaPayMaxAmountXof, assertProviderAmountCap } = paymentOrchestratorService.__test;

test('getFedaPayMaxAmountXof returns null when FEDAPAY_MAX_AMOUNT_XOF is unset', () => {
	const previousValue = process.env.FEDAPAY_MAX_AMOUNT_XOF;
	delete process.env.FEDAPAY_MAX_AMOUNT_XOF;

	try {
		assert.equal(getFedaPayMaxAmountXof(), null);
	} finally {
		if (previousValue === undefined) {
			delete process.env.FEDAPAY_MAX_AMOUNT_XOF;
		} else {
			process.env.FEDAPAY_MAX_AMOUNT_XOF = previousValue;
		}
	}
});

test('assertProviderAmountCap does not throw when FEDAPAY_MAX_AMOUNT_XOF is unset', () => {
	const previousValue = process.env.FEDAPAY_MAX_AMOUNT_XOF;
	delete process.env.FEDAPAY_MAX_AMOUNT_XOF;

	try {
		assert.doesNotThrow(() =>
			assertProviderAmountCap({ chargeAmount: 999999, chargeCurrency: 'XOF' }),
		);
	} finally {
		if (previousValue === undefined) {
			delete process.env.FEDAPAY_MAX_AMOUNT_XOF;
		} else {
			process.env.FEDAPAY_MAX_AMOUNT_XOF = previousValue;
		}
	}
});

test('assertProviderAmountCap throws BILLING_PROVIDER_AMOUNT_CAP when configured limit is exceeded', () => {
	const previousValue = process.env.FEDAPAY_MAX_AMOUNT_XOF;
	process.env.FEDAPAY_MAX_AMOUNT_XOF = '5000';

	try {
		assert.throws(
			() => assertProviderAmountCap({ chargeAmount: 5001, chargeCurrency: 'XOF' }),
			(error) => {
				assert.equal(error?.code, 'BILLING_PROVIDER_AMOUNT_CAP');
				assert.equal(error?.status, 422);
				assert.equal(error?.details?.providerMaxAmount, 5000);
				assert.equal(error?.details?.currency, 'XOF');
				return true;
			},
		);
	} finally {
		if (previousValue === undefined) {
			delete process.env.FEDAPAY_MAX_AMOUNT_XOF;
		} else {
			process.env.FEDAPAY_MAX_AMOUNT_XOF = previousValue;
		}
	}
});
