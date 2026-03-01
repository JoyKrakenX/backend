/** @format */

const normalizeQuota = (value) => {
	if (value === null || value === undefined) return null;

	if (typeof value === 'string' && value.trim() === '') {
		return null;
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
};

const isFiniteQuota = (value) => normalizeQuota(value) !== null;

module.exports = {
	normalizeQuota,
	isFiniteQuota,
};

