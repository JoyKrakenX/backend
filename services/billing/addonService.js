/** @format */

const SubscriptionAddon = require('../../models/SubscriptionAddon');
const { ADDON_CATALOG } = require('./constants');
const { normalizeQuota } = require('./quotaUtils');
const { addDaysUtc } = require('./periodService');

const normalizeCode = (value) => String(value || '').trim().toUpperCase();

const getAddonByCode = (addonCode) =>
	ADDON_CATALOG.find((entry) => entry.code === normalizeCode(addonCode)) || null;

const getPublicAddons = () =>
	[...ADDON_CATALOG]
		.filter((entry) => entry.isPublic !== false)
		.sort((left, right) => Number(left.publicOrder || 999) - Number(right.publicOrder || 999));

const getAvailableAddonsForPlan = (planCode) => {
	const normalizedPlanCode = normalizeCode(planCode);
	return getPublicAddons().filter((entry) =>
		Array.isArray(entry.eligiblePlanCodes) &&
		entry.eligiblePlanCodes.includes(normalizedPlanCode),
	);
};

const expireStaleAddons = async ({ organizationId, subscriptionId, now = new Date() }) => {
	const filter = {
		organizationId,
		status: 'active',
		endsAt: { $ne: null, $lte: now },
	};
	if (subscriptionId) {
		filter.subscriptionId = subscriptionId;
	}
	await SubscriptionAddon.updateMany(filter, {
		$set: {
			status: 'expired',
		},
	});
};

const getActiveAddonsForSubscription = async ({
	organizationId,
	subscriptionId,
	now = new Date(),
}) => {
	if (!organizationId || !subscriptionId) return [];
	await expireStaleAddons({ organizationId, subscriptionId, now });
	return SubscriptionAddon.find({
		organizationId,
		subscriptionId,
		status: 'active',
		$or: [{ endsAt: null }, { endsAt: { $gt: now } }],
	})
		.sort({ createdAt: 1 })
		.lean();
};

const buildAddonQuotaAdjustments = (addons = []) => {
	const adjustments = {
		votes: 0,
		chatConcurrent: 0,
		surveys: 0,
		admins: 0,
		exports: 0,
	};

	for (const addon of addons) {
		const definition = getAddonByCode(addon?.code);
		if (!definition) continue;
		const quantity = Math.max(1, Number(addon?.quantity || 1));
		const increments = definition.increments || {};
		adjustments.votes += Number(increments.votes || 0) * quantity;
		adjustments.chatConcurrent += Number(increments.chatConcurrent || 0) * quantity;
		adjustments.surveys += Number(increments.surveys || 0) * quantity;
		adjustments.admins += Number(increments.admins || 0) * quantity;
		adjustments.exports += Number(increments.exports || 0) * quantity;
	}

	return adjustments;
};

const mergePlanQuotasWithAddons = (planQuotas = {}, addons = []) => {
	const adjustments = buildAddonQuotaAdjustments(addons);
	const merged = {};
	for (const key of ['votes', 'chatConcurrent', 'surveys', 'admins', 'exports']) {
		const baseQuota = normalizeQuota(planQuotas?.[key]);
		merged[key] =
			baseQuota === null ? null : Math.max(0, Number(baseQuota || 0) + Number(adjustments[key] || 0));
	}
	return merged;
};

const normalizeAddonQuantity = (addonCode, quantity) => {
	const definition = getAddonByCode(addonCode);
	if (!definition) return null;
	const normalizedQuantity = Math.max(1, Math.trunc(Number(quantity || 1)));
	const maxQuantity = Math.max(1, Number(definition.maxQuantityPerCheckout || 1));
	if (!Number.isFinite(normalizedQuantity) || normalizedQuantity < 1) return null;
	return Math.min(normalizedQuantity, maxQuantity);
};

const canPurchaseAddon = ({ addonCode, effectivePlanCode }) => {
	const definition = getAddonByCode(addonCode);
	if (!definition) return { ok: false, reason: 'ADDON_NOT_FOUND' };
	if (
		!Array.isArray(definition.eligiblePlanCodes) ||
		!definition.eligiblePlanCodes.includes(normalizeCode(effectivePlanCode))
	) {
		return { ok: false, reason: 'ADDON_NOT_ALLOWED_FOR_PLAN' };
	}
	return { ok: true, addon: definition };
};

const activateAddonPurchase = async ({
	organizationId,
	subscription,
	invoice,
	addonCode,
	quantity = 1,
	now = new Date(),
}) => {
	const definition = getAddonByCode(addonCode);
	if (!organizationId || !subscription?._id || !definition) return null;

	const normalizedQuantity = normalizeAddonQuantity(addonCode, quantity);
	if (!normalizedQuantity) return null;

	let endsAt = null;
	if (definition.durationType === 'billing_cycle') {
		endsAt = subscription.currentPeriodEndAt || null;
	} else if (definition.durationType === 'fixed_hours') {
		endsAt = addDaysUtc(now, Number(definition.durationHours || 72) / 24);
	}

	return SubscriptionAddon.create({
		organizationId,
		subscriptionId: subscription._id,
		invoiceId: invoice?._id || null,
		code: definition.code,
		displayName: definition.displayName,
		kind: definition.kind,
		status: 'active',
		quantity: normalizedQuantity,
		priceUsd: Number(definition.priceUsd || 0),
		startedAt: now,
		activatedAt: now,
		endsAt,
		metadata: {
			durationType: definition.durationType,
			durationHours: definition.durationHours || null,
		},
	});
};

const summarizeAddons = (addons = []) =>
	addons.map((addon) => {
		const definition = getAddonByCode(addon?.code);
		return {
			code: addon.code,
			displayName: definition?.displayName || addon.displayName || addon.code,
			description: definition?.description || '',
			kind: addon.kind,
			quantity: Number(addon.quantity || 1),
			priceUsd: Number(addon.priceUsd || definition?.priceUsd || 0),
			startedAt: addon.startedAt || null,
			endsAt: addon.endsAt || null,
			status: addon.status || 'active',
		};
	});

module.exports = {
	getAddonByCode,
	getPublicAddons,
	getAvailableAddonsForPlan,
	getActiveAddonsForSubscription,
	buildAddonQuotaAdjustments,
	mergePlanQuotasWithAddons,
	normalizeAddonQuantity,
	canPurchaseAddon,
	activateAddonPurchase,
	summarizeAddons,
};
