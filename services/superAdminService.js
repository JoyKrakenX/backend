/** @format */

const {
	parseEmailAllowlist,
	normalizeEmail,
} = require('../utils/supportAdminAllowlist');
const { STATIC_BILLING_EXEMPT_EMAILS } = require('./billing/constants');

const getConfiguredBillingExemptEmails = () => {
	const envEmails = parseEmailAllowlist(
		process.env.BILLING_EXEMPT_EMAILS || process.env.SUPER_ADMIN_EMAILS,
	);
	if (!envEmails.length) return STATIC_BILLING_EXEMPT_EMAILS;
	const merged = new Set([
		...STATIC_BILLING_EXEMPT_EMAILS,
		...envEmails.map(normalizeEmail),
	]);
	return merged;
};

const isBillingExemptEmail = (email) => {
	const normalized = normalizeEmail(email);
	if (!normalized) return false;
	return getConfiguredBillingExemptEmails().has(normalized);
};

module.exports = {
	isBillingExemptEmail,
	getConfiguredBillingExemptEmails,
	// Legacy alias kept for backward compatibility in callsites progressively migrated.
	isSuperAdminEmail: isBillingExemptEmail,
	getConfiguredSuperAdminEmails: getConfiguredBillingExemptEmails,
};
