/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const DeviceTrace = require('../models/DeviceTrace');

const getRetentionDays = DeviceTrace.getRetentionDays || (() => 400);
const args = new Set(process.argv.slice(2));
const executeMode = args.has('--execute') && !args.has('--dry-run');
const dryRunMode = !executeMode;

const run = async () => {
	const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!mongoUri) {
		throw new Error('MONGO_URI is missing in environment.');
	}

	console.log(
		`Starting migrate-device-trace-indexes in ${dryRunMode ? 'dry-run' : 'execute'} mode.`,
	);
	await mongoose.connect(mongoUri);

	const indexes = [
		{
			key: { surveyId: 1, surveyType: 1, createdAt: -1 },
			options: { name: 'survey_type_createdAt' },
		},
		{
			key: { surveyId: 1, surveyType: 1, hardwareCoreHash: 1, renderingHash: 1 },
			options: { name: 'survey_machine_core_rendering', sparse: true },
		},
		{
			key: { userId: 1, createdAt: -1 },
			options: { name: 'userId_createdAt' },
		},
		{
			key: { expiresAt: 1 },
			options: { expireAfterSeconds: 0, name: 'expiresAt_ttl' },
		},
	];

	let existingIndexes = [];
	try {
		existingIndexes = await DeviceTrace.collection.indexes();
	} catch (error) {
		if (error?.codeName !== 'NamespaceNotFound' && error?.code !== 26) throw error;
		console.log(
			`${dryRunMode ? '[dry-run]' : '[execute]'} DeviceTrace collection does not exist yet.`,
		);
	}
	const nonTtlExpiresAtIndexes = existingIndexes.filter((indexSpec) => {
		const key = indexSpec.key || {};
		return (
			Object.keys(key).length === 1 &&
			key.expiresAt === 1 &&
			indexSpec.name !== 'expiresAt_ttl'
		);
	});
	for (const indexSpec of nonTtlExpiresAtIndexes) {
		if (dryRunMode) {
			console.log('[dry-run] would drop non-TTL expiresAt index', indexSpec.name);
			continue;
		}
		await DeviceTrace.collection.dropIndex(indexSpec.name);
		console.log('[execute] dropped non-TTL expiresAt index', indexSpec.name);
	}

	for (const indexSpec of indexes) {
		if (dryRunMode) {
			console.log('[dry-run] would ensure index', indexSpec.options.name);
			continue;
		}
		await DeviceTrace.collection.createIndex(indexSpec.key, indexSpec.options);
		console.log('[execute] ensured index', indexSpec.options.name);
	}

	const count = await DeviceTrace.countDocuments();
	const missingExpirationCount = await DeviceTrace.countDocuments({
		expiresAt: { $exists: false },
	});
	if (dryRunMode) {
		console.log(`[dry-run] DeviceTrace documents missing expiresAt: ${missingExpirationCount}`);
	} else if (missingExpirationCount > 0) {
		await DeviceTrace.updateMany(
			{ expiresAt: { $exists: false } },
			{
				$set: {
					expiresAt: new Date(
						Date.now() + getRetentionDays() * 24 * 60 * 60 * 1000,
					),
				},
			},
		);
		console.log(`[execute] backfilled expiresAt on ${missingExpirationCount} DeviceTrace documents`);
	}
	console.log(`${dryRunMode ? '[dry-run]' : '[execute]'} DeviceTrace documents: ${count}`);

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
