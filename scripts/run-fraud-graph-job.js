/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const { runFraudGraphJob } = require('../services/fraud/fraudGraphJobService');

const run = async () => {
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in environment.');
	}

	await mongoose.connect(process.env.MONGO_URI);
	const result = await runFraudGraphJob();
	console.log('fraud graph job result:', result);
	await mongoose.disconnect();
};

run().catch(async (error) => {
	console.error('fraud graph job failed:', error?.message || error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
