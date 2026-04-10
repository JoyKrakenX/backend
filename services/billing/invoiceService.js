/** @format */

const Invoice = require('../../models/Invoice');
const OrganizationMember = require('../../models/OrganizationMember');
const { getPeriodKeyUtc } = require('./periodService');
const { getAddonByCode } = require('./addonService');

const toMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const buildInvoiceKey = ({
	kind = 'renewal',
	organizationId,
	periodKey,
	subscriptionId,
	targetPlanCode = null,
}) => {
	if (!organizationId) return null;
	const normalizedKind = String(kind || 'renewal').trim().toLowerCase();
	if (normalizedKind === 'renewal') {
		return `renewal:${String(organizationId)}:${String(periodKey || getPeriodKeyUtc(new Date()))}`;
	}
	if (normalizedKind === 'upgrade') {
		return `upgrade:${String(organizationId)}:${String(targetPlanCode || 'same')}:${String(periodKey || getPeriodKeyUtc(new Date()))}`;
	}
	if (normalizedKind === 'retry' && subscriptionId) {
		return `retry:${String(subscriptionId)}:${String(periodKey || getPeriodKeyUtc(new Date()))}`;
	}
	return null;
};

const countOrganizationAdmins = async (organizationId) =>
	OrganizationMember.countDocuments({
		organizationId,
		role: { $in: ['owner', 'admin'] },
	});

const buildRecurringAddonLineItems = (addons = []) => {
	const lineItems = [];
	let totalUsd = 0;

	for (const addon of addons) {
		if (String(addon?.kind || '') !== 'recurring') continue;
		const definition = getAddonByCode(addon?.code);
		if (!definition) continue;
		const quantity = Math.max(1, Number(addon?.quantity || 1));
		const amountUsd = toMoney(Number(definition.priceUsd || 0) * quantity);
		totalUsd += amountUsd;
		lineItems.push({
			code: `addon_${String(definition.code).toLowerCase()}`,
			description: definition.displayName,
			quantity,
			unitPriceUsd: Number(definition.priceUsd || 0),
			amountUsd,
		});
	}

	return {
		lineItems,
		totalUsd: toMoney(totalUsd),
	};
};

const buildInvoiceDraft = async ({
	organizationId,
	subscription,
	plan,
	kind = 'renewal',
	periodKey = getPeriodKeyUtc(new Date()),
	targetPlanCode = null,
	addons = [],
}) => {
	const baseAmountUsd = Number(plan?.priceMonthlyUsd || 0);
	const lineItems = [];

	if (baseAmountUsd > 0) {
		lineItems.push({
			code: 'base_plan',
			description: `Abonnement ${plan?.displayName || subscription.planCode}`,
			quantity: 1,
			unitPriceUsd: baseAmountUsd,
			amountUsd: baseAmountUsd,
		});
	}

	const recurringAddons =
		kind === 'renewal' || kind === 'retry'
			? buildRecurringAddonLineItems(addons)
			: { lineItems: [], totalUsd: 0 };
	lineItems.push(...recurringAddons.lineItems);

	const totalAmountUsd = toMoney(baseAmountUsd + recurringAddons.totalUsd);

	return {
		organizationId,
		invoiceKey: buildInvoiceKey({
			kind,
			organizationId,
			periodKey,
			subscriptionId: subscription?._id || null,
			targetPlanCode,
		}),
		subscriptionId: subscription._id,
		periodKey,
		planCode: String(plan?.code || subscription.planCode || '').trim().toUpperCase(),
		currency: 'USD',
		kind,
		status: 'pending',
		baseAmountUsd,
		totalAmountUsd,
		dueAt: subscription.nextBillingAt || new Date(),
		lineItems,
	};
};

const buildAddonInvoiceDraft = ({
	organizationId,
	subscription,
	addon,
	quantity = 1,
	periodKey = getPeriodKeyUtc(new Date()),
}) => {
	const safeQuantity = Math.max(1, Math.trunc(Number(quantity || 1)));
	const unitPriceUsd = Number(addon?.priceUsd || 0);
	const amountUsd = toMoney(unitPriceUsd * safeQuantity);

	return {
		organizationId,
		invoiceKey: null,
		subscriptionId: subscription._id,
		periodKey,
		planCode: String(subscription?.planCode || '').trim().toUpperCase(),
		currency: 'USD',
		kind: 'addon',
		status: 'pending',
		baseAmountUsd: 0,
		totalAmountUsd: amountUsd,
		dueAt: new Date(),
		lineItems: [
			{
				code: `addon_${String(addon.code).toLowerCase()}`,
				description: addon.displayName,
				quantity: safeQuantity,
				unitPriceUsd,
				amountUsd,
			},
		],
		metadata: {
			invoiceType: 'addon',
			addonCode: addon.code,
			quantity: safeQuantity,
		},
	};
};

const createInvoiceDraft = async (input) => {
	const draft = await buildInvoiceDraft(input);
	return Invoice.create(draft);
};

module.exports = {
	toMoney,
	buildInvoiceKey,
	countOrganizationAdmins,
	buildRecurringAddonLineItems,
	buildInvoiceDraft,
	buildAddonInvoiceDraft,
	createInvoiceDraft,
};
