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

const getGlobalSupportAdminEmails = () =>
	parseEmailAllowlist(process.env.GLOBAL_SUPPORT_ADMIN_EMAILS);

const isSupportAdminEmail = (email) => {
	const normalized = normalizeEmail(email);
	if (!normalized) return false;
	return getSupportAdminEmails().includes(normalized);
};

const isGlobalSupportAdminEmail = (email) => {
	const normalized = normalizeEmail(email);
	if (!normalized) return false;
	return getGlobalSupportAdminEmails().includes(normalized);
};

const isAnySupportAdminEmail = (email) =>
	isGlobalSupportAdminEmail(email) || isSupportAdminEmail(email);

module.exports = {
	parseEmailAllowlist,
	normalizeEmail,
	getSupportAdminEmails,
	getGlobalSupportAdminEmails,
	isSupportAdminEmail,
	isGlobalSupportAdminEmail,
	isAnySupportAdminEmail,
};
