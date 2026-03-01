/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const Invoice = require('../models/Invoice');
const Subscription = require('../models/Subscription');
const PaymentEvent = require('../models/PaymentEvent');

const normalizePaymentCurrency = (value) => {
	const normalized = String(value || '').trim().toUpperCase();
	if (normalized === 'GNF') return 'GNF';
	return 'XOF';
};

const run = async () => {
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

	const organizations = await Organization.find({}).select('_id currency paymentCurrency').lean();
	let orgUpdated = 0;
	for (const org of organizations) {
		const currentPaymentCurrency = normalizePaymentCurrency(
			org.paymentCurrency || org.currency || 'XOF',
		);
		const updates = {};
		if (!org.paymentCurrency || String(org.paymentCurrency).toUpperCase() !== currentPaymentCurrency) {
			updates.paymentCurrency = currentPaymentCurrency;
		}
		if (Object.keys(updates).length > 0) {
			await Organization.updateOne({ _id: org._id }, { $set: updates });
			orgUpdated += 1;
		}
	}

	const subscriptions = await Subscription.find({}).select('_id provider').lean();
	let subUpdated = 0;
	for (const subscription of subscriptions) {
		const updates = {};
		if (String(subscription?.provider?.name || '').toLowerCase() !== 'fedapay') {
			updates['provider.name'] = 'fedapay';
		}
		if (subscription?.provider?.canAutoCharge !== false) {
			updates['provider.canAutoCharge'] = false;
		}
		if (Object.keys(updates).length > 0) {
			await Subscription.updateOne({ _id: subscription._id }, { $set: updates });
			subUpdated += 1;
		}
	}

	const invoices = await Invoice.find({}).select('_id organizationId provider fx charge').lean();
	let invUpdated = 0;
	for (const invoice of invoices) {
		const org = organizations.find((entry) => String(entry._id) === String(invoice.organizationId));
		const paymentCurrency = normalizePaymentCurrency(org?.paymentCurrency || org?.currency || 'XOF');

		const updates = {};
		if (String(invoice?.provider?.name || '').toLowerCase() !== 'fedapay') {
			updates['provider.name'] = 'fedapay';
		}
		if (!invoice?.fx?.baseCurrency) updates['fx.baseCurrency'] = 'USD';
		if (!invoice?.fx?.quoteCurrency) updates['fx.quoteCurrency'] = paymentCurrency;
		if (!invoice?.charge?.currency) updates['charge.currency'] = paymentCurrency;
		if (invoice?.charge?.minorUnitAmount === undefined) updates['charge.minorUnitAmount'] = null;
		if (Object.keys(updates).length > 0) {
			await Invoice.updateOne({ _id: invoice._id }, { $set: updates });
			invUpdated += 1;
		}
	}

	const paymentEvents = await PaymentEvent.find({}).select('_id provider').lean();
	let evtUpdated = 0;
	for (const paymentEvent of paymentEvents) {
		if (String(paymentEvent.provider || '').toLowerCase() !== 'fedapay') {
			await PaymentEvent.updateOne(
				{ _id: paymentEvent._id },
				{ $set: { provider: 'fedapay' } },
			);
			evtUpdated += 1;
		}
	}

	await Promise.all([
		Organization.syncIndexes(),
		Subscription.syncIndexes(),
		Invoice.syncIndexes(),
		PaymentEvent.syncIndexes(),
	]);

	console.log(`Organizations updated: ${orgUpdated}/${organizations.length}`);
	console.log(`Subscriptions updated: ${subUpdated}/${subscriptions.length}`);
	console.log(`Invoices updated: ${invUpdated}/${invoices.length}`);
	console.log(`Payment events updated: ${evtUpdated}/${paymentEvents.length}`);

	await mongoose.disconnect();
	console.log('FedaPay migration completed.');
};

run().catch((error) => {
	console.error('FedaPay migration failed:', error);
	process.exit(1);
});
