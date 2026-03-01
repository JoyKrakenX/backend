/** @format */

const { normalizeEmail } = require('../../utils/supportAdminAllowlist');

const PLAN_CODES = Object.freeze({
	CREATOR: 'CREATOR',
	BUSINESS: 'BUSINESS',
	TV_STANDARD: 'TV_STANDARD',
	TV_PRO: 'TV_PRO',
	ENTERPRISE: 'ENTERPRISE',
});

const PLAN_CATALOG = Object.freeze([
	{
		code: PLAN_CODES.CREATOR,
		displayName: 'Creator',
		priceMonthlyUsd: 19,
		quotas: {
			votes: 25000,
			chatConcurrent: 200,
			surveys: 15,
			admins: 2,
			exports: 10,
		},
	},
	{
		code: PLAN_CODES.BUSINESS,
		displayName: 'Business',
		priceMonthlyUsd: 79,
		quotas: {
			votes: 120000,
			chatConcurrent: 800,
			surveys: 60,
			admins: 8,
			exports: 100,
		},
	},
	{
		code: PLAN_CODES.TV_STANDARD,
		displayName: 'TV Standard',
		priceMonthlyUsd: 449,
		quotas: {
			votes: 600000,
			chatConcurrent: 2500,
			surveys: 200,
			admins: 20,
			exports: null, // null = unlimited
		},
		trialEligible: true,
	},
	{
		code: PLAN_CODES.TV_PRO,
		displayName: 'TV Pro',
		priceMonthlyUsd: 1299,
		quotas: {
			votes: 2000000,
			chatConcurrent: 8000,
			surveys: null, // null = unlimited
			admins: 50,
			exports: null, // null = unlimited
		},
	},
	{
		code: PLAN_CODES.ENTERPRISE,
		displayName: 'Enterprise',
		priceMonthlyUsd: null,
		quotas: {
			votes: null,
			chatConcurrent: null,
			surveys: null,
			admins: null,
			exports: null, // null = unlimited
		},
		isPublic: false,
	},
]);

const OVERAGE_RULES = Object.freeze({
	voteUnitUsd: 0.0007,
	chatTierSize: 500,
	chatTierUsd: 40,
	adminUnitUsd: 8,
});

const TRIAL_SETTINGS = Object.freeze({
	planCode: PLAN_CODES.TV_STANDARD,
	durationDays: 30,
	graceDays: 4,
});

const COMMERCIAL_RULES = Object.freeze({
	trialDays: TRIAL_SETTINGS.durationDays,
	graceDays: TRIAL_SETTINGS.graceDays,
	annualDiscountRange: Object.freeze({
		minPercent: 15,
		maxPercent: 20,
	}),
	overage: OVERAGE_RULES,
	quotaAlerts: Object.freeze([70, 90, 100]),
});

const ENTERPRISE_TEASER = Object.freeze({
	code: PLAN_CODES.ENTERPRISE,
	displayName: 'Enterprise',
	priceLabel: 'Sur devis',
	isSelectable: false,
	contactUrl: 'contact.html?topic=enterprise-sales&source=billing&plan=ENTERPRISE',
});

const SUBSCRIPTION_STATUSES = Object.freeze({
	TRIALING: 'trialing',
	ACTIVE: 'active',
	GRACE: 'grace',
	PAST_DUE: 'past_due',
	SUSPENDED: 'suspended',
	CANCELED: 'canceled',
});

const ENTITLEMENT_ACTIONS = Object.freeze({
	CREATE_SURVEY: 'create_survey',
	VOTE: 'vote',
	EXPORT: 'export',
	JOIN_CHAT: 'join_chat',
	MANAGE_ADMINS: 'manage_admins',
});

const ENTITLEMENT_DENY_CODES = Object.freeze({
	NO_ORG: 'NO_ORG',
	NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
	READ_ONLY: 'READ_ONLY',
	FEATURE_DISABLED: 'FEATURE_DISABLED',
	SURVEYS_LIMIT_REACHED: 'SURVEYS_LIMIT_REACHED',
	EXPORTS_LIMIT_REACHED: 'EXPORTS_LIMIT_REACHED',
	FORBIDDEN: 'FORBIDDEN',
});

const STATIC_BILLING_EXEMPT_EMAILS = new Set([
	normalizeEmail('tomseigneurjoyagbossou@gmail.com'),
]);

module.exports = {
	PLAN_CODES,
	PLAN_CATALOG,
	OVERAGE_RULES,
	TRIAL_SETTINGS,
	COMMERCIAL_RULES,
	ENTERPRISE_TEASER,
	SUBSCRIPTION_STATUSES,
	ENTITLEMENT_ACTIONS,
	ENTITLEMENT_DENY_CODES,
	STATIC_BILLING_EXEMPT_EMAILS,
};
