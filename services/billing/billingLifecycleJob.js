/** @format */

const cron = require('node-cron');

const Subscription = require('../../models/Subscription');
const { getPlanByCode } = require('./planService');
const { getMonthlyUsage } = require('./usageService');
const {
	findOrCreateInvoiceForOperation,
	resolveBillingContact,
	attemptAutoRenewalCharge,
} = require('./paymentOrchestratorService');
const { isConfigured: isFedaPayConfigured } = require('./fedapayService');
const { addDaysUtc } = require('./periodService');
const { SUBSCRIPTION_STATUSES, TRIAL_SETTINGS } = require('./constants');

const processSubscriptionLifecycle = async () => {
	const now = new Date();
	const subscriptions = await Subscription.find({
		status: {
			$in: [
				SUBSCRIPTION_STATUSES.TRIALING,
				SUBSCRIPTION_STATUSES.ACTIVE,
				SUBSCRIPTION_STATUSES.GRACE,
				SUBSCRIPTION_STATUSES.PAST_DUE,
			],
		},
	});

	for (const subscription of subscriptions) {
		const updates = {};

		if (
			subscription.status === SUBSCRIPTION_STATUSES.TRIALING &&
			subscription.trialEndsAt &&
			new Date(subscription.trialEndsAt).getTime() <= now.getTime()
		) {
			updates.status = SUBSCRIPTION_STATUSES.GRACE;
			updates.graceEndsAt = addDaysUtc(subscription.trialEndsAt, TRIAL_SETTINGS.graceDays);
		}

		if (
			subscription.status === SUBSCRIPTION_STATUSES.ACTIVE &&
			subscription.currentPeriodEndAt &&
			new Date(subscription.currentPeriodEndAt).getTime() <= now.getTime()
		) {
			let paymentResult = null;
			const plan = await getPlanByCode(subscription.planCode);
			const usage = await getMonthlyUsage(subscription.organizationId);
			if (plan && isFedaPayConfigured()) {
				const invoice = await findOrCreateInvoiceForOperation({
					organizationId: subscription.organizationId,
					subscription,
					plan,
					usage,
					mode: 'renewal',
				});
				const contact = await resolveBillingContact({
					organizationId: subscription.organizationId,
					fallbackEmail: process.env.BILLING_DEFAULT_EMAIL || null,
					fallbackName: 'Community Client',
				});
				paymentResult = await attemptAutoRenewalCharge({
					subscription,
					invoice,
					customerEmail: contact.email,
					customerName: contact.name,
					organizationId: subscription.organizationId,
					mode: 'renewal',
				});
			}

			const refreshed = await Subscription.findById(subscription._id).lean();
			const invoicePaid =
				String(paymentResult?.invoice?.status || '').trim().toLowerCase() === 'paid';
			if (!invoicePaid || refreshed?.status !== SUBSCRIPTION_STATUSES.ACTIVE) {
				updates.status = SUBSCRIPTION_STATUSES.PAST_DUE;
				updates.graceEndsAt = addDaysUtc(now, TRIAL_SETTINGS.graceDays);
			}
		}

		if (
			(subscription.status === SUBSCRIPTION_STATUSES.GRACE ||
				subscription.status === SUBSCRIPTION_STATUSES.PAST_DUE) &&
			subscription.graceEndsAt &&
			new Date(subscription.graceEndsAt).getTime() <= now.getTime()
		) {
			updates.status = SUBSCRIPTION_STATUSES.SUSPENDED;
			updates.readOnlySince = now;
		}

		if (Object.keys(updates).length > 0) {
			await Subscription.updateOne({ _id: subscription._id }, { $set: updates });
		}
	}
};

const registerBillingLifecycleJob = () => {
	cron.schedule('5 0 * * *', async () => {
		try {
			await processSubscriptionLifecycle();
		} catch (error) {
			console.error('billing lifecycle cron failed:', error?.message || error);
		}
	});
};

module.exports = {
	registerBillingLifecycleJob,
	processSubscriptionLifecycle,
};
