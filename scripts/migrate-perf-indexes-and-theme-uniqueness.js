/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
const ChatMessage = require('../models/ChatMessage');

const args = new Set(process.argv.slice(2));
const executeMode = args.has('--execute') && !args.has('--dry-run');
const dryRunMode = !executeMode;

const serializeKey = (key = {}) =>
	Object.entries(key)
		.map(([field, direction]) => `${field}:${direction}`)
		.join(',');

const sameKey = (left, right) => serializeKey(left) === serializeKey(right);

const report = {
	mode: dryRunMode ? 'dry-run' : 'execute',
	created: [],
	alreadyPresent: [],
	dropped: [],
	errors: [],
};

const printOperation = (verb, value) => {
	console.log(`[${report.mode}] ${verb}: ${value}`);
};

const ensureIndex = async ({
	label,
	model,
	key,
	options = {},
}) => {
	const collection = model.collection;
	const currentIndexes = await collection.indexes();
	const existing = currentIndexes.find((entry) => sameKey(entry.key, key));

	if (existing) {
		report.alreadyPresent.push({
			label,
			collection: collection.collectionName,
			indexName: existing.name,
		});
		printOperation('already-present', `${label} (${existing.name})`);
		return;
	}

	if (dryRunMode) {
		report.created.push({
			label,
			collection: collection.collectionName,
			indexName: options.name || serializeKey(key),
			dryRun: true,
		});
		printOperation('would-create', label);
		return;
	}

	const indexName = await collection.createIndex(key, options);
	report.created.push({
		label,
		collection: collection.collectionName,
		indexName,
		dryRun: false,
	});
	printOperation('created', `${label} (${indexName})`);
};

const dropUniqueThemeIndexes = async ({ label, model }) => {
	const collection = model.collection;
	const currentIndexes = await collection.indexes();
	const uniqueThemeIndexes = currentIndexes.filter(
		(entry) => entry.unique === true && sameKey(entry.key, { theme: 1 }),
	);

	if (!uniqueThemeIndexes.length) {
		report.alreadyPresent.push({
			label: `${label}.theme-unique-absent`,
			collection: collection.collectionName,
		});
		printOperation('already-present', `${label}.theme unique absent`);
		return;
	}

	for (const entry of uniqueThemeIndexes) {
		if (dryRunMode) {
			report.dropped.push({
				label,
				collection: collection.collectionName,
				indexName: entry.name,
				dryRun: true,
			});
			printOperation('would-drop', `${label} (${entry.name})`);
			continue;
		}

		await collection.dropIndex(entry.name);
		report.dropped.push({
			label,
			collection: collection.collectionName,
			indexName: entry.name,
			dryRun: false,
		});
		printOperation('dropped', `${label} (${entry.name})`);
	}
};

const run = async () => {
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in environment.');
	}

	console.log(
		`Starting migrate-perf-indexes-and-theme-uniqueness in ${report.mode} mode.`,
	);
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

	const indexSpecs = [
		{
			label: 'surveys.userId_createdAt',
			model: Survey,
			key: { userId: 1, createdAt: -1 },
			options: { name: 'userId_createdAt' },
		},
		{
			label: 'survey_2.userId_createdAt',
			model: Survey_2,
			key: { userId: 1, createdAt: -1 },
			options: { name: 'userId_createdAt' },
		},
		{
			label: 'opinions.userId_surveyId',
			model: Opinion,
			key: { userId: 1, surveyId: 1 },
			options: { name: 'userId_surveyId' },
		},
		{
			label: 'opinion_2.userId_surveyId',
			model: Opinion_2,
			key: { userId: 1, surveyId: 1 },
			options: { name: 'userId_surveyId' },
		},
		{
			label: 'opinion_flashes.userId_surveyId',
			model: Opinion_Flash,
			key: { userId: 1, surveyId: 1 },
			options: { name: 'userId_surveyId' },
		},
		{
			label: 'opinion_2_flashes.userId_surveyId',
			model: Opinion_2_Flash,
			key: { userId: 1, surveyId: 1 },
			options: { name: 'userId_surveyId' },
		},
		{
			label: 'chatmessages.surveyId_surveyModel_createdAt',
			model: ChatMessage,
			key: { surveyId: 1, surveyModel: 1, createdAt: -1 },
			options: { name: 'surveyId_surveyModel_createdAt' },
		},
	];

	for (const spec of indexSpecs) {
		try {
			await ensureIndex(spec);
		} catch (error) {
			report.errors.push({
				label: spec.label,
				error: error.message,
			});
			printOperation('error', `${spec.label} (${error.message})`);
		}
	}

	for (const surveyModelSpec of [
		{ label: 'surveys.theme_unique', model: Survey },
		{ label: 'survey_2.theme_unique', model: Survey_2 },
	]) {
		try {
			await dropUniqueThemeIndexes(surveyModelSpec);
		} catch (error) {
			report.errors.push({
				label: surveyModelSpec.label,
				error: error.message,
			});
			printOperation('error', `${surveyModelSpec.label} (${error.message})`);
		}
	}

	console.log('--- Migration report ---');
	console.log(`Mode: ${report.mode}`);
	console.log(`Created: ${report.created.length}`);
	console.log(`Already present: ${report.alreadyPresent.length}`);
	console.log(`Dropped: ${report.dropped.length}`);
	console.log(`Errors: ${report.errors.length}`);

	if (report.errors.length) {
		report.errors.forEach((entry) => {
			console.error(` - ${entry.label}: ${entry.error}`);
		});
		throw new Error('Migration completed with errors.');
	}

	await mongoose.disconnect();
	console.log('Disconnected from MongoDB.');
	console.log('Migration completed successfully.');
};

run().catch(async (error) => {
	console.error('Migration failed:', error.message || error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
