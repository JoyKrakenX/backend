/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const DeviceAccountLink = require('../models/DeviceAccountLink');

const dryRunMode = process.argv.includes('--dry-run');

const ensureConnection = async () => {
	const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!mongoUri) {
		throw new Error('MONGO_URI is missing in environment.');
	}
	await mongoose.connect(mongoUri);
};

const collectionExists = async () => {
	const collections = await mongoose.connection.db
		.listCollections({ name: DeviceAccountLink.collection.name })
		.toArray();
	return collections.length > 0;
};

const main = async () => {
	await ensureConnection();
	console.log(
		`Starting migrate-device-account-link-indexes in ${dryRunMode ? 'dry-run' : 'execute'} mode.`,
	);

	const exists = await collectionExists();
	if (!exists) {
		console.log(`${dryRunMode ? '[dry-run]' : '[execute]'} DeviceAccountLink collection does not exist yet.`);
	}

	const indexes = [
		{
			key: { userA: 1, userB: 1 },
			options: { unique: true, name: 'unique_device_account_pair' },
		},
		{
			key: { userA: 1, confidence: -1, lastSeenAt: -1 },
			options: { name: 'userA_confidence_lastSeenAt' },
		},
		{
			key: { userB: 1, confidence: -1, lastSeenAt: -1 },
			options: { name: 'userB_confidence_lastSeenAt' },
		},
		{
			key: { expiresAt: 1 },
			options: { expireAfterSeconds: 0, name: 'expiresAt_ttl' },
		},
	];

	for (const index of indexes) {
		console.log(`${dryRunMode ? '[dry-run] would ensure' : '[execute] ensuring'} index ${index.options.name}`);
		if (!dryRunMode) {
			await DeviceAccountLink.collection.createIndex(index.key, index.options);
		}
	}

	const count = exists ? await DeviceAccountLink.countDocuments() : 0;
	console.log(`${dryRunMode ? '[dry-run]' : '[execute]'} DeviceAccountLink documents: ${count}`);
	await mongoose.disconnect();
	console.log('Migration completed.');
};

main().catch(async (error) => {
	console.error('Migration failed:', error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
