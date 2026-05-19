/** @format */

const Plan = require('../../models/Plan');
const { PLAN_CATALOG, PUBLIC_PLAN_CODES, PLAN_CODES } = require('./constants');
const { normalizeQuota } = require('./quotaUtils');

const PLAN_QUOTA_KEYS = Object.freeze([
	'votes',
	'chatConcurrent',
	'surveys',
	'admins',
	'exports',
]);

const normalizeCatalogQuotas = (rawQuotas = {}) => {
	const normalized = {};
	for (const key of PLAN_QUOTA_KEYS) {
		normalized[key] = normalizeQuota(rawQuotas?.[key]);
	}
	return normalized;
};

const isPublicPlanCode = (planCode) =>
	PUBLIC_PLAN_CODES.includes(String(planCode || '').trim().toUpperCase());

const isPaidPlan = (plan) =>
	Number.isFinite(Number(plan?.priceMonthlyUsd)) && Number(plan?.priceMonthlyUsd) > 0;

const ensurePlanCatalog = async () => {
	const allowedCodes = PLAN_CATALOG.map((definition) => definition.code);

	for (const definition of PLAN_CATALOG) {
		const normalizedQuotas = normalizeCatalogQuotas(definition?.quotas || {});
		await Plan.findOneAndUpdate(
			{ code: definition.code },
			{
				$set: {
					code: definition.code,
					displayName: definition.displayName,
					priceMonthlyUsd: definition.priceMonthlyUsd ?? null,
					priceLabel: definition.priceLabel ?? null,
					isQuoteOnly: Boolean(definition.isQuoteOnly),
					currency: 'USD',
					quotas: normalizedQuotas,
					features: {
						chatEnabled: definition?.features?.chatEnabled !== false,
						exportsEnabled: definition?.features?.exportsEnabled !== false,
						privateSurveysEnabled:
							definition?.features?.privateSurveysEnabled !== false,
					},
					isPublic: definition.isPublic !== false,
					isSelectable: definition.isSelectable !== false,
					trialEligible: Boolean(definition.trialEligible),
					recommended: Boolean(definition.recommended),
					publicOrder: Number(definition.publicOrder || 999),
					audience: String(definition.audience || ''),
					description: String(definition.description || ''),
					highlights: Array.isArray(definition.highlights)
						? definition.highlights.map((entry) => String(entry || '').trim()).filter(Boolean)
						: [],
					ctaLabel: String(definition.ctaLabel || ''),
					availableAddonCodes: Array.isArray(definition.availableAddonCodes)
						? definition.availableAddonCodes.map((entry) => String(entry || '').trim()).filter(Boolean)
						: [],
				},
				$unset: {
					overage: '',
					isLegacy: '',
					billingModel: '',
				},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true },
		);
	}

	await Plan.deleteMany({ code: { $nin: allowedCodes } });
};

const getPublicPlans = async () =>
	Plan.find({ isPublic: true })
		.sort({ publicOrder: 1, displayName: 1 })
		.lean();

const getPlanByCode = async (planCode) => {
	if (!planCode) return null;
	const normalizedCode = String(planCode).trim().toUpperCase();
	const resolvedCode =
		normalizedCode === PLAN_CODES.UNLIMITED ||
		['FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE'].includes(normalizedCode)
			? PLAN_CODES.UNLIMITED
			: normalizedCode;
	return Plan.findOne({ code: resolvedCode }).lean();
};

module.exports = {
	ensurePlanCatalog,
	getPublicPlans,
	getPlanByCode,
	isPublicPlanCode,
	isPaidPlan,
};
