/** @format */

function normalizeQuestion(rawQuestion) {
	const normalized = String(rawQuestion || '').trim();
	if (!normalized) return normalized;

	return normalized.endsWith('?') ? normalized : `${normalized}?`;
}

module.exports = {
	normalizeQuestion,
};
