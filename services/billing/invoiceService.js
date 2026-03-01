/** @format */

const Invoice = require('../../models/Invoice');
const OrganizationMember = require('../../models/OrganizationMember');
const { OVERAGE_RULES } = require('./constants');
const { getPeriodKeyUtc } = require('./periodService');
const { normalizeQuota } = require('./quotaUtils');

const toMoney = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const calculateOverage = ({ plan, usage, adminsCount = 1 }) => {
	const quotas = plan?.quotas || {};
	const counts = usage?.counts || {};
	const votesUsed = Number(counts.votes || 0);
	const chatPeakUsed = Number(usage?.chatPeakMax || 0);
	const adminsCurrent = Number(adminsCount || 0);
	const adminsPeakUsed = Math.max(
		Number(usage?.adminsPeak || 0),
		Number(adminsCurrent || 0),
	);

	const votesQuota = normalizeQuota(quotas.votes);
	const chatQuota = normalizeQuota(quotas.chatConcurrent);
	const adminsQuota = normalizeQuota(quotas.admins);

	const extraVotes = votesQuota === null ? 0 : Math.max(0, votesUsed - votesQuota);
	const extraChat = chatQuota === null ? 0 : Math.max(0, chatPeakUsed - chatQuota);
	const extraAdmins =
		adminsQuota === null ? 0 : Math.max(0, adminsPeakUsed - adminsQuota);

	const votesUsd = toMoney(extraVotes * Number(OVERAGE_RULES.voteUnitUsd || 0));
	const chatTiers =
		extraChat <= 0 ? 0 : Math.ceil(extraChat / Number(OVERAGE_RULES.chatTierSize || 500));
	const chatUsd = toMoney(chatTiers * Number(OVERAGE_RULES.chatTierUsd || 0));
	const adminsUsd = toMoney(extraAdmins * Number(OVERAGE_RULES.adminUnitUsd || 0));
	const totalUsd = toMoney(votesUsd + chatUsd + adminsUsd);

	return {
		votesUsd,
		chatUsd,
		adminsUsd,
		totalUsd,
		details: {
			extraVotes,
			extraChat,
			extraAdmins,
			chatTiers,
			adminsPeakUsed,
			adminsCurrent,
		},
	};
};

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

const buildInvoiceDraft = async ({
	organizationId,
	subscription,
	plan,
	usage,
	kind = 'renewal',
	periodKey = getPeriodKeyUtc(new Date()),
	targetPlanCode = null,
}) => {
	const adminsCount = await countOrganizationAdmins(organizationId);
	const overage = calculateOverage({ plan, usage, adminsCount });
	const baseAmountUsd = Number(plan?.priceMonthlyUsd || 0);
	const totalAmountUsd = toMoney(baseAmountUsd + overage.totalUsd);

	const lineItems = [
		{
			code: 'base_plan',
			description: `Abonnement ${plan?.displayName || subscription.planCode}`,
			quantity: 1,
			unitPriceUsd: baseAmountUsd,
			amountUsd: baseAmountUsd,
		},
	];

	if (overage.votesUsd > 0) {
		lineItems.push({
			code: 'overage_votes',
			description: 'Depassement votes',
			quantity: overage.details.extraVotes,
			unitPriceUsd: OVERAGE_RULES.voteUnitUsd,
			amountUsd: overage.votesUsd,
		});
	}
	if (overage.chatUsd > 0) {
		lineItems.push({
			code: 'overage_chat_concurrent',
			description: 'Depassement simultane chatroom',
			quantity: overage.details.chatTiers,
			unitPriceUsd: OVERAGE_RULES.chatTierUsd,
			amountUsd: overage.chatUsd,
		});
	}
	if (overage.adminsUsd > 0) {
		lineItems.push({
			code: 'overage_admins',
			description: 'Admins supplementaires',
			quantity: overage.details.extraAdmins,
			unitPriceUsd: OVERAGE_RULES.adminUnitUsd,
			amountUsd: overage.adminsUsd,
		});
	}

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
		overage,
		totalAmountUsd,
		dueAt: subscription.nextBillingAt || new Date(),
		lineItems,
	};
};

const createInvoiceDraft = async (input) => {
	const draft = await buildInvoiceDraft(input);
	return Invoice.create(draft);
};

module.exports = {
	calculateOverage,
	buildInvoiceDraft,
	buildInvoiceKey,
	createInvoiceDraft,
	countOrganizationAdmins,
};
