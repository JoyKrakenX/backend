const test = require('node:test');
const assert = require('node:assert/strict');

const {
	createFreeTrialSubscriptionInput,
	getEffectivePlanCode,
} = require('../../services/billing/subscriptionService');

test('createFreeTrialSubscriptionInput starts new organizations on FREE with Growth trial', () => {
	const now = new Date('2026-04-09T10:00:00.000Z');
	const input = createFreeTrialSubscriptionInput('507f191e810c19729de860ea', now);

	assert.equal(input.planCode, 'FREE');
	assert.equal(input.trialPlanCode, 'GROWTH');
	assert.equal(input.status, 'trialing');
	assert.equal(new Date(input.trialEndsAt).toISOString(), '2026-04-23T10:00:00.000Z');
	assert.equal(new Date(input.currentPeriodEndAt).toISOString(), '2026-05-09T10:00:00.000Z');
});

test('getEffectivePlanCode uses trialPlanCode while subscription is trialing', () => {
	assert.equal(
		getEffectivePlanCode({ status: 'trialing', planCode: 'FREE', trialPlanCode: 'GROWTH' }),
		'GROWTH',
	);
	assert.equal(getEffectivePlanCode({ status: 'active', planCode: 'STARTER', trialPlanCode: 'GROWTH' }), 'STARTER');
});
