/** @format */

const { CLEAN_FRAUD_STATUSES, RAW_FRAUD_STATUSES } = require('../../utils/fraudConfig');

const LEGACY_FRAUD_STATUS_FALLBACK = Object.freeze([
	{ fraudStatus: { $exists: false } },
	{ fraudStatus: null },
]);

const buildStatusFilter = (mode = 'clean') => {
	if (mode === 'raw') {
		return {
			$or: [
				{ fraudStatus: { $in: RAW_FRAUD_STATUSES } },
				...LEGACY_FRAUD_STATUS_FALLBACK,
			],
		};
	}
	if (mode === 'quarantine') {
		return { fraudStatus: 'quarantined' };
	}
	if (mode === 'clean') {
		return {
			$or: [
				{ fraudStatus: { $in: CLEAN_FRAUD_STATUSES } },
				...LEGACY_FRAUD_STATUS_FALLBACK,
			],
		};
	}
	return {};
};

const countDocumentsByMode = async (
	OpinionModel,
	baseMatch = {},
	mode = 'clean',
) => {
	if (!OpinionModel) return 0;
	return OpinionModel.countDocuments({
		...baseMatch,
		...buildStatusFilter(mode),
	});
};

const aggregateCountBySurvey = async (OpinionModel, surveyIds = [], mode = 'clean') => {
	if (!OpinionModel || !Array.isArray(surveyIds) || !surveyIds.length) {
		return new Map();
	}

	const rows = await OpinionModel.aggregate([
		{
			$match: {
				surveyId: { $in: surveyIds },
				...buildStatusFilter(mode),
			},
		},
		{
			$group: {
				_id: '$surveyId',
				count: { $sum: 1 },
			},
		},
	]);

	return new Map(rows.map((row) => [String(row._id), Number(row.count) || 0]));
};

const getIntegritySnapshotForSurvey = async (OpinionModel, surveyId) => {
	const [rawCounts, cleanCounts, quarantinedCounts, confirmedFraudCounts, topSignalsRows] =
		await Promise.all([
			countDocumentsByMode(OpinionModel, { surveyId }, 'raw'),
			countDocumentsByMode(OpinionModel, { surveyId }, 'clean'),
			countDocumentsByMode(OpinionModel, { surveyId }, 'quarantine'),
			OpinionModel.countDocuments({ surveyId, fraudStatus: 'confirmed_fraud' }),
			OpinionModel.aggregate([
				{
					$match: {
						surveyId,
						fraudReasons: { $exists: true, $ne: [] },
					},
				},
				{ $unwind: '$fraudReasons' },
				{
					$group: {
						_id: '$fraudReasons',
						count: { $sum: 1 },
					},
				},
				{ $sort: { count: -1 } },
				{ $limit: 5 },
			]),
		]);

	const raw = Number(rawCounts || 0);
	const clean = Number(cleanCounts || 0);
	const quarantined = Number(quarantinedCounts || 0);
	const confirmedFraud = Number(confirmedFraudCounts || 0);
	const confidenceScore =
		raw <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((clean / raw) * 100)));

	return {
		rawCounts: raw,
		cleanCounts: clean,
		quarantinedCounts: quarantined,
		confirmedFraudCounts: confirmedFraud,
		confidenceScore,
		topRiskSignals: (topSignalsRows || []).map((entry) => ({
			code: String(entry?._id || ''),
			count: Number(entry?.count || 0),
		})),
	};
};

module.exports = {
	buildStatusFilter,
	countDocumentsByMode,
	aggregateCountBySurvey,
	getIntegritySnapshotForSurvey,
};
