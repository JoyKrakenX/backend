/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const Invoice = require('../models/Invoice');
const Subscription = require('../models/Subscription');
const { SUBSCRIPTION_STATUSES } = require('../services/billing/constants');

const hasApplyFlag = process.argv.includes('--apply');
const runMode = hasApplyFlag ? 'apply' : 'dry-run';

const toId = (value) => String(value || '').trim();

const collectTargets = async () => {
	const pendingInvoices = await Invoice.find({ status: 'pending' })
		.select('_id organizationId subscriptionId status metadata createdAt')
		.lean();

	if (!pendingInvoices.length) {
		return { pendingInvoices: [], trialingSubscriptionsMap: new Map(), targets: [] };
	}

	const subscriptionIds = [
		...new Set(
			pendingInvoices.map((invoice) => toId(invoice.subscriptionId)).filter(Boolean),
		),
	];

	const trialingSubscriptions = await Subscription.find({
		_id: { $in: subscriptionIds },
		status: SUBSCRIPTION_STATUSES.TRIALING,
	})
		.select('_id status trialEndsAt organizationId')
		.lean();

	const trialingSubscriptionsMap = new Map(
		trialingSubscriptions.map((subscription) => [toId(subscription._id), subscription]),
	);

	const targets = pendingInvoices.filter((invoice) =>
		trialingSubscriptionsMap.has(toId(invoice.subscriptionId)),
	);

	return { pendingInvoices, trialingSubscriptionsMap, targets };
};

const printTargetReport = (targets = [], trialingSubscriptionsMap = new Map()) => {
	if (!targets.length) {
		console.log('Aucune facture pending liee a un abonnement trialing.');
		return;
	}

	console.log(`Factures candidates: ${targets.length}`);
	console.log('---');
	targets.forEach((invoice) => {
		const subscription = trialingSubscriptionsMap.get(toId(invoice.subscriptionId)) || null;
		console.log(
			[
				`invoiceId=${toId(invoice._id)}`,
				`organizationId=${toId(invoice.organizationId)}`,
				`subscriptionId=${toId(invoice.subscriptionId)}`,
				`trialEndsAt=${subscription?.trialEndsAt ? new Date(subscription.trialEndsAt).toISOString() : '-'}`,
				`createdAt=${invoice?.createdAt ? new Date(invoice.createdAt).toISOString() : '-'}`,
			].join(' | '),
		);
	});
};

const applyCleanup = async (targets = []) => {
	if (!targets.length) {
		return { matched: 0, modified: 0 };
	}

	const cleanedAt = new Date().toISOString();
	const operations = targets.map((invoice) => {
		const currentMetadata =
			invoice?.metadata && typeof invoice.metadata === 'object' && !Array.isArray(invoice.metadata)
				? invoice.metadata
				: {};

		return {
			updateOne: {
				filter: { _id: invoice._id, status: 'pending' },
				update: {
					$set: {
						status: 'void',
						metadata: {
							...currentMetadata,
							cleanupReason: 'TRIALING_PENDING_VOID',
							cleanedAt,
						},
					},
				},
			},
		};
	});

	const result = await Invoice.bulkWrite(operations, { ordered: false });
	return {
		matched: Number(result?.matchedCount || 0),
		modified: Number(result?.modifiedCount || 0),
	};
};

const run = async () => {
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI manquant.');
	}

	await mongoose.connect(process.env.MONGO_URI);
	console.log(`Connected to MongoDB. Mode: ${runMode}`);

	const { pendingInvoices, trialingSubscriptionsMap, targets } = await collectTargets();
	console.log(`Total pending invoices scanned: ${pendingInvoices.length}`);
	printTargetReport(targets, trialingSubscriptionsMap);

	if (runMode !== 'apply') {
		console.log('Dry-run termine. Aucune mutation effectuee.');
		return;
	}

	const summary = await applyCleanup(targets);
	console.log('---');
	console.log(`Cleanup applied. matched=${summary.matched}, modified=${summary.modified}`);
};

run()
	.catch((error) => {
		console.error('void-trial-pending-invoices failed:', error?.message || error);
		process.exitCode = 1;
	})
	.finally(async () => {
		try {
			await mongoose.disconnect();
		} catch (_error) {
			// ignore disconnect errors
		}
	});
