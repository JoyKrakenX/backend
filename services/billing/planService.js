/** @format */

const Plan = require('../../models/Plan');
const { PLAN_CATALOG, OVERAGE_RULES } = require('./constants');
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

const ensurePlanCatalog = async () => {
	for (const definition of PLAN_CATALOG) {
		const normalizedQuotas = normalizeCatalogQuotas(definition?.quotas || {});
		await Plan.findOneAndUpdate(
			{ code: definition.code },
			{
				$set: {
					code: definition.code,
					displayName: definition.displayName,
					priceMonthlyUsd: definition.priceMonthlyUsd ?? null,
					currency: 'USD',
					// Convention: null means unlimited quota.
					quotas: normalizedQuotas,
					overage: OVERAGE_RULES,
					features: {
						chatEnabled: true,
						exportsEnabled: true,
						privateSurveysEnabled: true,
					},
					isPublic: definition.isPublic !== false,
					trialEligible: Boolean(definition.trialEligible),
				},
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true },
		);
	}
};

const getPublicPlans = async () =>
	Plan.find({ isPublic: true }).sort({ priceMonthlyUsd: 1, displayName: 1 }).lean();

const getPlanByCode = async (planCode) => {
	if (!planCode) return null;
	return Plan.findOne({ code: String(planCode).trim().toUpperCase() }).lean();
};

module.exports = {
	ensurePlanCatalog,
	getPublicPlans,
	getPlanByCode,
};
