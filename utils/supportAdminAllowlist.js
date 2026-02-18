/** @format */

const parseEmailAllowlist = (value) =>
	String(value || '')
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const getSupportAdminEmails = () => {
	const primary = parseEmailAllowlist(process.env.SUPPORT_ADMIN_EMAILS);
	if (primary.length > 0) return primary;
	return parseEmailAllowlist(process.env.ADMIN_EMAILS);
};

const isSupportAdminEmail = (email) => {
	const normalized = normalizeEmail(email);
	if (!normalized) return false;
	return getSupportAdminEmails().includes(normalized);
};

module.exports = {
	parseEmailAllowlist,
	normalizeEmail,
	getSupportAdminEmails,
	isSupportAdminEmail,
};
