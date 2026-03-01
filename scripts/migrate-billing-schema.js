/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Subscription = require('../models/Subscription');
const { buildInvoiceKey } = require('../services/billing/invoiceService');

const run = async () => {
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

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
		if (Object.keys(updates).length > 0) {
			await Subscription.updateOne({ _id: subscription._id }, { $set: updates });
			subscriptionUpdated += 1;
		}
	}

	await Invoice.syncIndexes();
	await Subscription.syncIndexes();

	console.log(`Invoices updated: ${invoiceUpdated}/${invoices.length}`);
	console.log(`Subscriptions updated: ${subscriptionUpdated}/${subscriptions.length}`);
	await mongoose.disconnect();
	console.log('Billing schema migration completed.');
};

run().catch((error) => {
	console.error('Billing schema migration failed:', error);
	process.exit(1);
});
