const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeQuota, isFiniteQuota } = require('../../services/billing/quotaUtils');

test('normalizeQuota keeps unlimited null semantics', () => {
	assert.equal(normalizeQuota(null), null);
	assert.equal(normalizeQuota(undefined), null);
	assert.equal(normalizeQuota(''), null);
	assert.equal(normalizeQuota('   '), null);
	assert.equal(normalizeQuota('abc'), null);
	assert.equal(normalizeQuota(-1), null);
	assert.equal(normalizeQuota('-42'), null);
});

test('normalizeQuota keeps finite non-negative values', () => {
	assert.equal(normalizeQuota(0), 0);
	assert.equal(normalizeQuota('0'), 0);
	assert.equal(normalizeQuota(12), 12);
	assert.equal(normalizeQuota('18'), 18);
});

test('isFiniteQuota is false for unlimited and true for explicit numeric quotas', () => {
	assert.equal(isFiniteQuota(null), false);
	assert.equal(isFiniteQuota(undefined), false);
	assert.equal(isFiniteQuota(''), false);
	assert.equal(isFiniteQuota(0), true);
	assert.equal(isFiniteQuota(1), true);
});
