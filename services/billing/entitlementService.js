/** @format */

const User = require('../../models/User');
const Organization = require('../../models/Organization');
const OrganizationMember = require('../../models/OrganizationMember');
const { isBillingExemptEmail } = require('../superAdminService');
const { getPlanByCode } = require('./planService');
const { getOrganizationSubscription } = require('./subscriptionService');
const { getMonthlyUsage } = require('./usageService');
const { normalizeQuota, isFiniteQuota } = require('./quotaUtils');
const { logSecurityEvent } = require('../securityAuditService');
const {
	ENTITLEMENT_ACTIONS,
	ENTITLEMENT_DENY_CODES,
	SUBSCRIPTION_STATUSES,
} = require('./constants');

const toSafeCount = (value) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) return 0;
	return Math.trunc(parsed);
};

const buildDenied = (code, message, extras = {}) => ({
	allowed: false,
	code,
	message,
	...extras,
});

const buildAllowed = (extras = {}) => ({
	allowed: true,
	code: null,
	message: null,
	...extras,
});

const canWriteWithStatus = (status) =>
	[
		SUBSCRIPTION_STATUSES.TRIALING,
		SUBSCRIPTION_STATUSES.ACTIVE,
		SUBSCRIPTION_STATUSES.GRACE,
		SUBSCRIPTION_STATUSES.PAST_DUE,
	].includes(String(status || ''));

const getUserIdentity = async ({ userId, userEmail }) => {
	let email = String(userEmail || '').trim().toLowerCase();
	if (!email && userId) {
		const dbUser = await User.findById(userId).select('email').lean();
		email = String(dbUser?.email || '').trim().toLowerCase();
	}
	return {
		email,
		isBillingExempt: isBillingExemptEmail(email),
	};
};

const getOrganizationRole = async (organizationId, userId) => {
	if (!organizationId || !userId) return null;
	const member = await OrganizationMember.findOne({
		organizationId,
		userId,
	})
		.select('role')
		.lean();
	return member?.role || null;
};

const isBillingExemptForOwnedOrganization = async ({
	organizationId,
	userId,
	identity,
}) => {
	if (!organizationId || !userId || !identity?.isBillingExempt) return false;
	const organization = await Organization.findById(organizationId)
		.select('ownerUserId')
		.lean();
	if (!organization?.ownerUserId) return false;
	return String(organization.ownerUserId) === String(userId);
};

const computeUsageSnapshot = async ({ organizationId, explicitUsage }) => {
	if (explicitUsage) return explicitUsage;
	return (await getMonthlyUsage(organizationId)) || {
		counts: { votes: 0, surveys: 0, exports: 0 },
		chatPeakMax: 0,
		adminsPeak: 1,
	};
};

const authorizeAction = async ({
	action,
	organizationId,
	userId,
	userEmail,
	plan: explicitPlan = null,
	subscription: explicitSubscription = null,
	usage: explicitUsage = null,
	role: explicitRole = null,
}) => {
	const denyWithAudit = async (code, message, extras = {}) => {
		await logSecurityEvent({
			event: 'entitlement_denied',
			level: 'warning',
			action,
			code,
			message,
			organizationId,
			userId,
			userEmail,
			meta: {
				role: explicitRole || null,
			},
		});
		return buildDenied(code, message, extras);
	};

	const identity = await getUserIdentity({ userId, userEmail });

	if (!organizationId) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_ORG,
			'Aucune organisation active pour cette action.',
		);
	}

	const role =
		explicitRole || (await getOrganizationRole(organizationId, userId));
	const billingExempt = await isBillingExemptForOwnedOrganization({
		organizationId,
		userId,
		identity,
	});
	const resolvedRole = billingExempt && !role ? 'owner' : role;
	const isManagementAction =
		action === ENTITLEMENT_ACTIONS.CREATE_SURVEY ||
		action === ENTITLEMENT_ACTIONS.MANAGE_ADMINS;
	if (isManagementAction && !['owner', 'admin'].includes(String(resolvedRole || ''))) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.FORBIDDEN,
			'Acces reserve aux administrateurs de l organisation.',
		);
	}

	if (billingExempt) {
		return buildAllowed({
			plan: explicitPlan || null,
			subscription: explicitSubscription || null,
			usage: explicitUsage || null,
			role: resolvedRole || 'owner',
			isSuperAdmin: false,
			billingExempt: true,
			billingExemptScope: 'owner_only',
			overage: false,
		});
	}

	const subscription =
		explicitSubscription || (await getOrganizationSubscription(organizationId));
	if (!subscription) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_SUBSCRIPTION,
			'Abonnement introuvable.',
		);
	}

	if (!canWriteWithStatus(subscription.status)) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.READ_ONLY,
			'Organisation en mode lecture seule. Veuillez regulariser le paiement.',
			{
				subscription,
			},
		);
	}

	const plan = explicitPlan || (await getPlanByCode(subscription.planCode));
	if (!plan) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_SUBSCRIPTION,
			'Plan abonnement introuvable.',
			{
				subscription,
			},
		);
	}

	const usage = await computeUsageSnapshot({
		organizationId,
		explicitUsage,
	});

	const quotas = plan.quotas || {};
	const counts = usage.counts || {};
	const resultPayload = {
		plan,
		subscription,
		usage,
		role: resolvedRole,
		isSuperAdmin: false,
		billingExempt: false,
		billingExemptScope: null,
	};

	if (action === ENTITLEMENT_ACTIONS.CREATE_SURVEY) {
		const surveysQuota = normalizeQuota(quotas.surveys);
		if (isFiniteQuota(surveysQuota) && toSafeCount(counts.surveys) >= surveysQuota) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.SURVEYS_LIMIT_REACHED,
				'Quota mensuel de sondages atteint.',
				resultPayload,
			);
		}
		return buildAllowed({ ...resultPayload, overage: false });
	}

	if (action === ENTITLEMENT_ACTIONS.EXPORT) {
		if (plan.features?.exportsEnabled === false) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.FEATURE_DISABLED,
				'Fonction export indisponible sur ce plan.',
				resultPayload,
			);
		}
		const exportsQuota = normalizeQuota(quotas.exports);
		if (isFiniteQuota(exportsQuota) && toSafeCount(counts.exports) >= exportsQuota) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.EXPORTS_LIMIT_REACHED,
				'Quota mensuel des exports atteint.',
				resultPayload,
			);
		}
		return buildAllowed({ ...resultPayload, overage: false });
	}

	if (action === ENTITLEMENT_ACTIONS.JOIN_CHAT) {
		if (plan.features?.chatEnabled === false) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.FEATURE_DISABLED,
				'Fonction chat indisponible sur ce plan.',
				resultPayload,
			);
		}
		return buildAllowed({ ...resultPayload, overage: false });
	}

	if (action === ENTITLEMENT_ACTIONS.MANAGE_ADMINS) {
		const adminLimit = normalizeQuota(quotas.admins);
		const adminsCount = toSafeCount(usage.adminsPeak);
		const overage = isFiniteQuota(adminLimit) && adminsCount >= adminLimit;
		return buildAllowed({ ...resultPayload, overage });
	}

	if (action === ENTITLEMENT_ACTIONS.VOTE) {
		const voteLimit = normalizeQuota(quotas.votes);
		const overage = isFiniteQuota(voteLimit) && toSafeCount(counts.votes) >= voteLimit;
		return buildAllowed({ ...resultPayload, overage });
	}

	return buildAllowed({ ...resultPayload, overage: false });
};

module.exports = {
	authorizeAction,
};
