/** @format */

const {
	parseEmailAllowlist,
	normalizeEmail,
	isSupportAdminEmail,
	isGlobalSupportAdminEmail,
} = require('./supportAdminAllowlist');
const { isBillingExemptEmail } = require('../services/superAdminService');

const normalizeRole = (value) => {
	const role = String(value || '').trim().toLowerCase();
	return ['user', 'support', 'admin'].includes(role) ? role : 'user';
};

const resolveEffectiveRoleByEmail = ({ email, fallbackRole = 'user' } = {}) => {
	const normalizedEmail = normalizeEmail(email);
	const normalizedFallbackRole = normalizeRole(fallbackRole);
	if (!normalizedEmail) return normalizedFallbackRole;

	// Dedicated global support privilege has the highest priority.
	if (isGlobalSupportAdminEmail(normalizedEmail)) return 'support';

	// Billing exemption stays billing-only and should not imply global admin rights.
	if (isBillingExemptEmail(normalizedEmail)) return 'user';

	// Legacy support/admin allowlists (backward compatibility).
	if (isSupportAdminEmail(normalizedEmail)) return 'admin';

	const adminEmails = parseEmailAllowlist(process.env.ADMIN_EMAILS);
	const supportEmails = parseEmailAllowlist(process.env.SUPPORT_AGENT_EMAILS);

	if (adminEmails.includes(normalizedEmail)) return 'admin';
	if (supportEmails.includes(normalizedEmail)) return 'support';
	return normalizedFallbackRole;
};

module.exports = {
	resolveEffectiveRoleByEmail,
	normalizeRole,
};
