/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const DeviceTrace = require('../models/DeviceTrace');
const {
	compareTrace,
	upsertDeviceAccountLink,
} = require('../services/fraud/machineSignatureService');

const dryRunMode = process.argv.includes('--dry-run');
const daysArg = process.argv.find((arg) => arg.startsWith('--days='));
const maxGroupsArg = process.argv.find((arg) => arg.startsWith('--max-groups='));
const lookbackDays = Math.max(1, Math.min(400, Number(daysArg?.split('=')[1] || 400)));
const maxGroups = Math.max(1, Math.min(10000, Number(maxGroupsArg?.split('=')[1] || 2000)));

const short = (value) => (value ? String(value).slice(-8) : null);

const ensureConnection = async () => {
	const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!mongoUri) {
		throw new Error('MONGO_URI is missing in environment.');
	}
	await mongoose.connect(mongoUri);
};

const main = async () => {
	await ensureConnection();
	const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
	console.log(
		`Starting backfill-device-account-links in ${dryRunMode ? 'dry-run' : 'execute'} mode, lookback=${lookbackDays}d.`,
	);

	const groups = await DeviceTrace.aggregate([
		{ $match: { createdAt: { $gte: since } } },
		{
			$group: {
				_id: { surveyId: '$surveyId', surveyType: '$surveyType' },
				count: { $sum: 1 },
			},
		},
		{ $match: { count: { $gte: 2 } } },
		{ $sort: { count: -1 } },
		{ $limit: maxGroups },
	]);

	let comparedPairs = 0;
	let strongMatches = 0;
	let upsertedLinks = 0;
	const examples = [];

	for (const group of groups) {
		const traces = await DeviceTrace.find({
			surveyId: group._id.surveyId,
			surveyType: group._id.surveyType,
			createdAt: { $gte: since },
		})
			.sort({ createdAt: 1 })
			.limit(200)
			.lean();

		const processedPairs = new Set();
		for (let i = 0; i < traces.length; i += 1) {
			for (let j = i + 1; j < traces.length; j += 1) {
				if (String(traces[i].userId) === String(traces[j].userId)) continue;
				const pairKey = [String(traces[i].userId), String(traces[j].userId)].sort().join(':');
				if (processedPairs.has(pairKey)) continue;
				processedPairs.add(pairKey);
				comparedPairs += 1;
				const comparison = compareTrace(traces[j], traces[i]);
				if (!comparison.blocked || Number(comparison.score || 0) < 92) continue;
				strongMatches += 1;
				if (examples.length < 20) {
					examples.push({
						surveyId: short(group._id.surveyId),
						surveyType: group._id.surveyType,
						userA: short(traces[i].userId),
						userB: short(traces[j].userId),
						score: comparison.score,
						matchedFamilies: comparison.matchedFamilies,
					});
				}
				if (!dryRunMode) {
					await upsertDeviceAccountLink({
						userId: traces[j].userId,
						matchedTrace: traces[i],
						comparison,
					});
					upsertedLinks += 1;
				}
			}
		}
	}

	console.log(
		JSON.stringify(
			{
				dryRun: dryRunMode,
				groups: groups.length,
				comparedPairs,
				strongMatches,
				upsertedLinks,
				examples,
			},
			null,
			2,
		),
	);
	await mongoose.disconnect();
	console.log('Backfill completed.');
};

main().catch(async (error) => {
	console.error('Backfill failed:', error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
