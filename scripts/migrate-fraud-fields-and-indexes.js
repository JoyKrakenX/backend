/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const Opinion = require('../models/Opinion');
const Opinion2 = require('../models/Opinion_2');
const OpinionFlash = require('../models/Opinion_Flash');
const Opinion2Flash = require('../models/Opinion_2_Flash');

const args = new Set(process.argv.slice(2));
const executeMode = args.has('--execute') && !args.has('--dry-run');
const dryRunMode = !executeMode;

const MODELS = [
	{ label: 'Opinion', model: Opinion },
	{ label: 'Opinion_2', model: Opinion2 },
	{ label: 'Opinion_Flash', model: OpinionFlash },
	{ label: 'Opinion_2_Flash', model: Opinion2Flash },
];

const ensureIndexes = async (Model) => {
	const indexes = [
		{
			key: { surveyId: 1, fraudStatus: 1, createdAt: -1 },
			options: { name: 'surveyId_fraudStatus_createdAt' },
		},
		{
			key: { userId: 1, createdAt: -1 },
			options: { name: 'userId_createdAt_fraud' },
		},
		{
			key: { ipHash: 1, createdAt: -1 },
			options: { name: 'ipHash_createdAt_fraud', sparse: true },
		},
		{
			key: { deviceHash: 1, createdAt: -1 },
			options: { name: 'deviceHash_createdAt_fraud', sparse: true },
		},
	];

	for (const indexSpec of indexes) {
		if (dryRunMode) {
			console.log('[dry-run] would ensure index', Model.collection.collectionName, indexSpec.options.name);
			continue;
		}
		await Model.collection.createIndex(indexSpec.key, indexSpec.options);
		console.log('[execute] ensured index', Model.collection.collectionName, indexSpec.options.name);
	}
};

const run = async () => {
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in environment.');
	}

	console.log(`Starting migrate-fraud-fields-and-indexes in ${dryRunMode ? 'dry-run' : 'execute'} mode.`);
	await mongoose.connect(process.env.MONGO_URI);

	for (const { label, model } of MODELS) {
		const filter = { fraudStatus: { $exists: false } };
		if (dryRunMode) {
			const count = await model.countDocuments(filter);
			console.log(`[dry-run] ${label}: would update ${count} documents`);
		} else {
			const updateResult = await model.updateMany(filter, {
				$set: {
					fraudStatus: 'accepted',
					fraudScore: 0,
					fraudReasons: [],
					antiFraudVersion: 0,
					ipRiskProvider: 'none',
					ipRiskScore: 0,
					captchaVerified: false,
					challengeType: 'none',
					reviewedBy: null,
					reviewedAt: null,
					reasonHash: null,
				},
			});
			console.log(`[execute] ${label}: updated ${updateResult.modifiedCount} documents`);
		}

		await ensureIndexes(model);
	}

	await mongoose.disconnect();
	console.log('Migration completed.');
};

run().catch(async (error) => {
	console.error('Migration failed:', error?.message || error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
