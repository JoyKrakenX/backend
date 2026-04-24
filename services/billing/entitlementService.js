/** @format */

const User = require('../../models/User');
const Organization = require('../../models/Organization');
const OrganizationMember = require('../../models/OrganizationMember');
const { isBillingExemptEmail } = require('../superAdminService');
const { getPlanByCode } = require('./planService');
const {
	getOrganizationSubscription,
	getEffectivePlanCode,
} = require('./subscriptionService');
const { getMonthlyUsage } = require('./usageService');
const { normalizeQuota, isFiniteQuota } = require('./quotaUtils');
const { logSecurityEvent } = require('../securityAuditService');
const {
	getActiveAddonsForSubscription,
	mergePlanQuotasWithAddons,
	getAvailableAddonsForPlan,
	summarizeAddons,
} = require('./addonService');
const {
	ENTITLEMENT_ACTIONS,
	ENTITLEMENT_DENY_CODES,
	SUBSCRIPTION_STATUSES,
} = require('./constants');

const ENTITLEMENT_CACHE_TTLS_MS = Object.freeze({
	userIdentity: 5 * 60 * 1000,
	orgRole: 60 * 1000,
	ownerExempt: 60 * 1000,
	subscription: 15 * 1000,
	plan: 10 * 60 * 1000,
	addons: 15 * 1000,
	adminsCurrent: 30 * 1000,
	joinChatAction: 10 * 1000,
});

const entitlementCaches = {
	userIdentity: new Map(),
	orgRole: new Map(),
	ownerExempt: new Map(),
	subscription: new Map(),
	plan: new Map(),
	addons: new Map(),
	adminsCurrent: new Map(),
	joinChatAction: new Map(),
};

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
		SUBSCRIPTION_STATUSES.PAST_DUE,
	].includes(String(status || ''));

const getCacheKeyPart = (value) => String(value || '');

const getCachedAsync = async (cache, key, ttlMs, loader) => {
	if (!ttlMs || ttlMs <= 0 || !cache || !key) {
		return loader();
	}

	const now = Date.now();
	const existingEntry = cache.get(key);
	if (existingEntry && existingEntry.expiresAt > now) {
		return existingEntry.valuePromise;
	}

	const valuePromise = Promise.resolve()
		.then(loader)
		.catch((error) => {
			const currentEntry = cache.get(key);
			if (currentEntry && currentEntry.valuePromise === valuePromise) {
				cache.delete(key);
			}
			throw error;
		});

	cache.set(key, {
		expiresAt: now + ttlMs,
		valuePromise,
	});

	return valuePromise;
};

const getCachedPlanByCode = async (planCode) => {
	const normalizedPlanCode = String(planCode || '').trim().toUpperCase();
	if (!normalizedPlanCode) return null;

	return getCachedAsync(
		entitlementCaches.plan,
		normalizedPlanCode,
		ENTITLEMENT_CACHE_TTLS_MS.plan,
		() => getPlanByCode(normalizedPlanCode),
	);
};

const getUserIdentity = async ({ userId, userEmail }) => {
	let email = String(userEmail || '').trim().toLowerCase();
	if (!email && userId) {
		const identity = await getCachedAsync(
			entitlementCaches.userIdentity,
			getCacheKeyPart(userId),
			ENTITLEMENT_CACHE_TTLS_MS.userIdentity,
			async () => {
				const dbUser = await User.findById(userId).select('email').lean();
				return {
					email: String(dbUser?.email || '').trim().toLowerCase(),
				};
			},
		);
		email = identity.email;
	}
	return {
		email,
		isBillingExempt: isBillingExemptEmail(email),
	};
};

const getOrganizationRole = async (organizationId, userId) => {
	if (!organizationId || !userId) return null;
	return getCachedAsync(
		entitlementCaches.orgRole,
		`${getCacheKeyPart(organizationId)}:${getCacheKeyPart(userId)}`,
		ENTITLEMENT_CACHE_TTLS_MS.orgRole,
		async () => {
			const member = await OrganizationMember.findOne({
				organizationId,
				userId,
			})
				.select('role')
				.lean();
			return member?.role || null;
		},
	);
};

const isBillingExemptForOwnedOrganization = async ({
	organizationId,
	userId,
	identity,
}) => {
	if (!organizationId || !userId || !identity?.isBillingExempt) return false;
	return getCachedAsync(
		entitlementCaches.ownerExempt,
		`${getCacheKeyPart(organizationId)}:${getCacheKeyPart(userId)}`,
		ENTITLEMENT_CACHE_TTLS_MS.ownerExempt,
		async () => {
			const organization = await Organization.findById(organizationId)
				.select('ownerUserId')
				.lean();
			if (!organization?.ownerUserId) return false;
			return String(organization.ownerUserId) === String(userId);
		},
	);
};

const computeUsageSnapshot = async ({
	organizationId,
	explicitUsage,
	explicitSubscription = null,
}) => {
	if (explicitUsage) return explicitUsage;
	return (
		(await getMonthlyUsage(organizationId, new Date(), {
			subscription: explicitSubscription,
		})) || {
			counts: { votes: 0, surveys: 0, exports: 0 },
			chatPeakMax: 0,
			adminsPeak: 1,
			adminsCurrent: 1,
		}
	);
};

const buildRemaining = (quota, consumed) => {
	const normalizedQuota = normalizeQuota(quota);
	if (normalizedQuota === null) return null;
	return Math.max(0, normalizedQuota - toSafeCount(consumed));
};

const buildNextAction = ({ effectivePlanCode, metricKey }) => {
	const availableAddons = getAvailableAddonsForPlan(effectivePlanCode);
	if (metricKey === 'votes') {
		const responseAddon = availableAddons.find((entry) =>
			String(entry.code || '').includes('RESPONSE_PACK'),
		);
		if (responseAddon) {
			return {
				type: 'addon',
				addonCode: responseAddon.code,
				label: responseAddon.displayName,
			};
		}
	}

	if (metricKey === 'admins') {
		const adminAddon = availableAddons.find((entry) =>
			String(entry.code || '').includes('ADMIN_PACK'),
		);
		if (adminAddon) {
			return {
				type: 'addon',
				addonCode: adminAddon.code,
				label: adminAddon.displayName,
			};
		}
	}

	if (metricKey === 'chatConcurrent') {
		const liveAddon = availableAddons.find((entry) =>
			String(entry.code || '').includes('LIVE_EVENT_BOOST'),
		);
		if (liveAddon) {
			return {
				type: 'addon',
				addonCode: liveAddon.code,
				label: liveAddon.displayName,
			};
		}
	}

	return {
		type: 'upgrade',
		label: 'Passer au plan superieur',
	};
};

const resolveEntitlementContext = async ({
	organizationId,
	userId,
	userEmail,
	plan: explicitPlan = null,
	basePlan: explicitBasePlan = null,
	subscription: explicitSubscription = null,
	usage: explicitUsage = null,
	role: explicitRole = null,
	includeUsage = true,
	includeAdminsCurrent = true,
	includeRole = true,
}) => {
	const identity = await getUserIdentity({ userId, userEmail });
	const role =
		explicitRole ||
		(includeRole ? await getOrganizationRole(organizationId, userId) : null);
	const billingExempt = await isBillingExemptForOwnedOrganization({
		organizationId,
		userId,
		identity,
	});

	const subscription =
		explicitSubscription ||
		(await getCachedAsync(
			entitlementCaches.subscription,
			getCacheKeyPart(organizationId),
			ENTITLEMENT_CACHE_TTLS_MS.subscription,
			() => getOrganizationSubscription(organizationId),
		));
	const effectivePlanCode = getEffectivePlanCode(subscription);
	const basePlanCode = String(subscription?.planCode || '').trim().toUpperCase();
	const basePlan =
		explicitBasePlan ||
		(explicitPlan && explicitPlan.code === basePlanCode ? explicitPlan : null) ||
		(await getCachedPlanByCode(basePlanCode));
	const effectivePlan =
		explicitPlan ||
		(effectivePlanCode ? await getCachedPlanByCode(effectivePlanCode) : null);
	const usage =
		includeUsage ?
			await computeUsageSnapshot({
				organizationId,
				explicitUsage,
				explicitSubscription: subscription,
			})
		:	null;
	const adminsCurrent =
		Number.isFinite(Number(explicitUsage?.adminsCurrent))
			? Math.max(0, Math.trunc(Number(explicitUsage.adminsCurrent)))
			: includeAdminsCurrent ?
				await getCachedAsync(
					entitlementCaches.adminsCurrent,
					getCacheKeyPart(organizationId),
					ENTITLEMENT_CACHE_TTLS_MS.adminsCurrent,
					() =>
						OrganizationMember.countDocuments({
							organizationId,
							role: { $in: ['owner', 'admin'] },
						}),
				  )
			:	1;
	const addons =
		subscription?._id
			? await getCachedAsync(
					entitlementCaches.addons,
					`${getCacheKeyPart(organizationId)}:${getCacheKeyPart(subscription._id)}`,
					ENTITLEMENT_CACHE_TTLS_MS.addons,
					() =>
						getActiveAddonsForSubscription({
							organizationId,
							subscriptionId: subscription._id,
						}),
			  )
			: [];
	const effectiveQuotas = mergePlanQuotasWithAddons(effectivePlan?.quotas || {}, addons);
	const resolvedRole = billingExempt && !role ? 'owner' : role;
	const normalizedUsage = {
		...(usage || {}),
		counts: usage?.counts || { votes: 0, surveys: 0, exports: 0 },
		chatPeakMax: Number(usage?.chatPeakMax || 0),
		adminsPeak: Number(usage?.adminsPeak || adminsCurrent || 1),
		adminsCurrent,
	};

	return {
		identity,
		role: resolvedRole,
		billingExempt,
		subscription,
		basePlan,
		effectivePlan,
		effectivePlanCode,
		basePlanCode,
		usage: normalizedUsage,
		addons,
		addonsSummary: summarizeAddons(addons),
		effectiveQuotas,
	};
};

const authorizeActionUncached = async ({
	action,
	organizationId,
	userId,
	userEmail,
	plan: explicitPlan = null,
	basePlan: explicitBasePlan = null,
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

	if (!organizationId) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_ORG,
			'Aucune organisation active pour cette action.',
		);
	}

	const isManagementAction =
		action === ENTITLEMENT_ACTIONS.CREATE_SURVEY ||
		action === ENTITLEMENT_ACTIONS.MANAGE_ADMINS;

	const context = await resolveEntitlementContext({
		organizationId,
		userId,
		userEmail,
		plan: explicitPlan,
		basePlan: explicitBasePlan,
		subscription: explicitSubscription,
		usage: explicitUsage,
		role: explicitRole,
		includeUsage: action !== ENTITLEMENT_ACTIONS.JOIN_CHAT,
		includeAdminsCurrent: action === ENTITLEMENT_ACTIONS.MANAGE_ADMINS,
		includeRole: isManagementAction,
	});

	if (isManagementAction && !['owner', 'admin'].includes(String(context.role || ''))) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.FORBIDDEN,
			"Accès réservé aux administrateurs de l'organisation.",
		);
	}

	if (context.billingExempt) {
		return buildAllowed({
			plan: context.effectivePlan || explicitPlan || null,
			basePlan: context.basePlan || null,
			subscription: context.subscription || explicitSubscription || null,
			usage: context.usage || explicitUsage || null,
			role: context.role || 'owner',
			isSuperAdmin: false,
			billingExempt: true,
			billingExemptScope: 'owner_only',
			addons: context.addonsSummary || [],
			effectiveQuotas: context.effectiveQuotas || {},
		});
	}

	if (!context.subscription) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_SUBSCRIPTION,
			'Abonnement introuvable.',
		);
	}

	if (!canWriteWithStatus(context.subscription.status)) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.READ_ONLY,
			'Organisation en mode lecture seule. Veuillez régulariser le paiement.',
			{
				subscription: context.subscription,
			},
		);
	}

	if (!context.effectivePlan) {
		return denyWithAudit(
			ENTITLEMENT_DENY_CODES.NO_SUBSCRIPTION,
			'Plan abonnement introuvable.',
			{
				subscription: context.subscription,
			},
		);
	}

	const quotas = context.effectiveQuotas || {};
	const counts = context.usage.counts || {};
	const resultPayload = {
		plan: context.effectivePlan,
		basePlan: context.basePlan,
		effectivePlanCode: context.effectivePlanCode,
		basePlanCode: context.basePlanCode,
		subscription: context.subscription,
		usage: context.usage,
		role: context.role,
		isSuperAdmin: false,
		billingExempt: false,
		billingExemptScope: null,
		addons: context.addonsSummary,
		effectiveQuotas: quotas,
	};

	if (action === ENTITLEMENT_ACTIONS.CREATE_SURVEY) {
		const surveysQuota = normalizeQuota(quotas.surveys);
		if (isFiniteQuota(surveysQuota) && toSafeCount(counts.surveys) >= surveysQuota) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.SURVEYS_LIMIT_REACHED,
				'Capacite de campagnes atteinte pour ce cycle.',
				{
					...resultPayload,
					nextAction: buildNextAction({
						effectivePlanCode: context.effectivePlanCode,
						metricKey: 'surveys',
					}),
				},
			);
		}
		return buildAllowed(resultPayload);
	}

	if (action === ENTITLEMENT_ACTIONS.EXPORT) {
		if (context.effectivePlan.features?.exportsEnabled === false) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.FEATURE_DISABLED,
				'Les exports avances ne sont pas disponibles sur ce plan.',
				{
					...resultPayload,
					nextAction: buildNextAction({
						effectivePlanCode: context.effectivePlanCode,
						metricKey: 'exports',
					}),
				},
			);
		}
		const exportsQuota = normalizeQuota(quotas.exports);
		if (isFiniteQuota(exportsQuota) && toSafeCount(counts.exports) >= exportsQuota) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.EXPORTS_LIMIT_REACHED,
				'Capacite d exports atteinte pour ce cycle.',
				{
					...resultPayload,
					nextAction: buildNextAction({
						effectivePlanCode: context.effectivePlanCode,
						metricKey: 'exports',
					}),
				},
			);
		}
		return buildAllowed(resultPayload);
	}

	if (action === ENTITLEMENT_ACTIONS.JOIN_CHAT) {
		if (context.effectivePlan.features?.chatEnabled === false) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.FEATURE_DISABLED,
				'Le chat n est pas disponible sur ce plan.',
				resultPayload,
			);
		}
		return buildAllowed(resultPayload);
	}

	if (action === ENTITLEMENT_ACTIONS.MANAGE_ADMINS) {
		const adminLimit = normalizeQuota(quotas.admins);
		const adminsCount = Math.max(
			toSafeCount(context.usage.adminsPeak),
			toSafeCount(context.usage.adminsCurrent),
		);
		if (isFiniteQuota(adminLimit) && adminsCount >= adminLimit) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.ADMINS_LIMIT_REACHED,
				'Capacite admins atteinte pour ce cycle.',
				{
					...resultPayload,
					remaining: {
						admins: buildRemaining(adminLimit, adminsCount),
					},
					nextAction: buildNextAction({
						effectivePlanCode: context.effectivePlanCode,
						metricKey: 'admins',
					}),
				},
			);
		}
		return buildAllowed(resultPayload);
	}

	if (action === ENTITLEMENT_ACTIONS.VOTE) {
		const voteLimit = normalizeQuota(quotas.votes);
		if (isFiniteQuota(voteLimit) && toSafeCount(counts.votes) >= voteLimit) {
			return denyWithAudit(
				ENTITLEMENT_DENY_CODES.RESPONSES_LIMIT_REACHED,
				'Capacite de participation atteinte pour ce cycle.',
				{
					...resultPayload,
					remaining: {
						votes: buildRemaining(voteLimit, counts.votes),
					},
					nextAction: buildNextAction({
						effectivePlanCode: context.effectivePlanCode,
						metricKey: 'votes',
					}),
				},
			);
		}
		return buildAllowed(resultPayload);
	}

	return buildAllowed(resultPayload);
};

const authorizeAction = async (params) => {
	const {
		action,
		organizationId,
		userId,
		userEmail,
		plan,
		basePlan,
		subscription,
		usage,
		role,
	} = params || {};

	const shouldUseJoinChatCache =
		action === ENTITLEMENT_ACTIONS.JOIN_CHAT &&
		!plan &&
		!basePlan &&
		!subscription &&
		!usage &&
		!role &&
		organizationId &&
		userId;

	if (!shouldUseJoinChatCache) {
		return authorizeActionUncached(params);
	}

	const joinChatCacheKey = [
		getCacheKeyPart(action),
		getCacheKeyPart(organizationId),
		getCacheKeyPart(userId),
		getCacheKeyPart(String(userEmail || '').trim().toLowerCase()),
	].join(':');

	return getCachedAsync(
		entitlementCaches.joinChatAction,
		joinChatCacheKey,
		ENTITLEMENT_CACHE_TTLS_MS.joinChatAction,
		() => authorizeActionUncached(params),
	);
};

const clearEntitlementCaches = () => {
	for (const cache of Object.values(entitlementCaches)) {
		cache.clear();
	}
};

module.exports = {
	authorizeAction,
	resolveEntitlementContext,
	clearEntitlementCaches,
};
