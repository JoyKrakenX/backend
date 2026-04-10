/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Plan = require('../models/Plan');
const Subscription = require('../models/Subscription');
const UsageMonthly = require('../models/UsageMonthly');
const UsageEvent = require('../models/UsageEvent');
const SubscriptionAddon = require('../models/SubscriptionAddon');
const { buildInvoiceKey } = require('../services/billing/invoiceService');
const { ensurePlanCatalog } = require('../services/billing/planService');
const { buildUsageWindowDescriptor } = require('../services/billing/periodService');

const run = async () => {
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');
	await ensurePlanCatalog();

	const invoices = await Invoice.find({}).select('_id invoiceKey kind organizationId periodKey subscriptionId provider').lean();
	let invoiceUpdated = 0;
	for (const invoice of invoices) {
		const updates = {};
		if (!invoice.invoiceKey) {
			let invoiceKey = buildInvoiceKey({
				kind: invoice.kind,
				organizationId: invoice.organizationId,
				periodKey: invoice.periodKey,
				subscriptionId: invoice.subscriptionId,
			});
			if (invoiceKey) {
				const existing = await Invoice.findOne({ invoiceKey }).select('_id').lean();
				if (existing && String(existing._id) !== String(invoice._id)) {
					invoiceKey = `${invoiceKey}:${String(invoice._id)}`;
				}
			}
			if (invoiceKey) updates.invoiceKey = invoiceKey;
		}
		if (!invoice?.provider?.chargeMode) {
			updates['provider.chargeMode'] = 'unknown';
		}
		if (Object.keys(updates).length > 0) {
			await Invoice.updateOne({ _id: invoice._id }, { $set: updates });
			invoiceUpdated += 1;
		}
	}

	const subscriptions = await Subscription.find({}).select('_id provider').lean();
	let subscriptionUpdated = 0;
	for (const subscription of subscriptions) {
		const updates = {};
		if (subscription?.provider?.canAutoCharge === undefined) {
			updates['provider.canAutoCharge'] = false;
		}
		if (subscription?.provider?.paymentMethodId === undefined) {
			updates['provider.paymentMethodId'] = null;
		}
		if (subscription?.trialPlanCode === undefined) {
			updates.trialPlanCode = null;
		}
		if (Object.keys(updates).length > 0) {
			await Subscription.updateOne({ _id: subscription._id }, { $set: updates });
			subscriptionUpdated += 1;
		}
	}

	const subscriptionsByOrganization = new Map();
	const liveSubscriptions = await Subscription.find({})
		.select('organizationId planCode trialPlanCode status currentPeriodStartAt currentPeriodEndAt')
		.lean();
	for (const subscription of liveSubscriptions) {
		subscriptionsByOrganization.set(String(subscription.organizationId), subscription);
	}

	const usageRows = await UsageMonthly.find({})
		.select('_id organizationId periodType periodStartAt periodEndAt periodKey')
		.lean();
	let usageUpdated = 0;
	for (const row of usageRows) {
		const subscription = subscriptionsByOrganization.get(String(row.organizationId));
		const descriptor = buildUsageWindowDescriptor({
			subscription,
			date: row.periodStartAt || row.periodEndAt || new Date(),
		});
		const updates = {};
		if (!row.periodType) updates.periodType = descriptor.periodType;
		if (!row.periodStartAt) updates.periodStartAt = descriptor.periodStartAt;
		if (!row.periodEndAt) updates.periodEndAt = descriptor.periodEndAt;
		if (!row.periodKey && descriptor.periodKey) updates.periodKey = descriptor.periodKey;
		if (Object.keys(updates).length > 0) {
			await UsageMonthly.updateOne({ _id: row._id }, { $set: updates });
			usageUpdated += 1;
		}
	}

	const usageEvents = await UsageEvent.find({})
		.select('_id organizationId periodType periodStartAt periodEndAt periodKey')
		.lean();
	let usageEventUpdated = 0;
	for (const event of usageEvents) {
		const subscription = subscriptionsByOrganization.get(String(event.organizationId));
		const descriptor = buildUsageWindowDescriptor({
			subscription,
			date: event.periodStartAt || event.periodEndAt || new Date(),
		});
		const updates = {};
		if (!event.periodType) updates.periodType = descriptor.periodType;
		if (!event.periodStartAt) updates.periodStartAt = descriptor.periodStartAt;
		if (!event.periodEndAt) updates.periodEndAt = descriptor.periodEndAt;
		if (!event.periodKey && descriptor.periodKey) updates.periodKey = descriptor.periodKey;
		if (Object.keys(updates).length > 0) {
			await UsageEvent.updateOne({ _id: event._id }, { $set: updates });
			usageEventUpdated += 1;
		}
	}

	await Plan.syncIndexes();
	await Invoice.syncIndexes();
	await Subscription.syncIndexes();
	await UsageMonthly.syncIndexes();
	await UsageEvent.syncIndexes();
	await SubscriptionAddon.syncIndexes();

	console.log(`Invoices updated: ${invoiceUpdated}/${invoices.length}`);
	console.log(`Subscriptions updated: ${subscriptionUpdated}/${subscriptions.length}`);
	console.log(`UsageMonthly updated: ${usageUpdated}/${usageRows.length}`);
	console.log(`UsageEvent updated: ${usageEventUpdated}/${usageEvents.length}`);
	await mongoose.disconnect();
	console.log('Billing schema migration completed.');
};

run().catch((error) => {
	console.error('Billing schema migration failed:', error);
	process.exit(1);
});
