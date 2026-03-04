/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');

// Configurable via EXPORT_REGULAR_VOTER_MIN_SURVEYS (fallback = 3).
const DEFAULT_REGULAR_VOTER_MIN_SURVEYS = 3;
const PARTICIPANT_CHUNK_SIZE = 400;
const SURVEY_CHUNK_SIZE = 2000;

const normalizeRegularVoterThreshold = (value) => {
	const parsed = Number.parseInt(String(value ?? '').trim(), 10);
	if (Number.isInteger(parsed) && parsed >= 1) {
		return parsed;
	}
	return DEFAULT_REGULAR_VOTER_MIN_SURVEYS;
};

const nowIso = () => new Date().toISOString();

const chunkArray = (items = [], size = 1) => {
	const chunkSize = Math.max(1, Number.parseInt(size, 10) || 1);
	const chunks = [];
	for (let index = 0; index < items.length; index += chunkSize) {
		chunks.push(items.slice(index, index + chunkSize));
	}
	return chunks;
};

const toUniqueByStringValue = (items = []) => {
	const seen = new Set();
	const unique = [];
	for (const item of items) {
		const key = String(item || '').trim();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		unique.push(item);
	}
	return unique;
};

const buildUnavailableRegularVoterInsight = ({
	threshold,
	errorCode = 'INSIGHT_UNAVAILABLE',
} = {}) => ({
	status: 'unavailable',
	scope: 'creator_surveys',
	population: 'current_survey_participants',
	includeCurrentSurvey: true,
	thresholdMinSurveys: normalizeRegularVoterThreshold(threshold),
	participantCount: null,
	regularVoterCount: null,
	regularVoterRate: null,
	errorCode,
	generatedAt: nowIso(),
});

const buildEmptyRegularVoterInsight = ({ threshold, participantCount = 0 } = {}) => ({
	status: 'ok',
	scope: 'creator_surveys',
	population: 'current_survey_participants',
	includeCurrentSurvey: true,
	thresholdMinSurveys: normalizeRegularVoterThreshold(threshold),
	participantCount: Math.max(0, Number.parseInt(participantCount, 10) || 0),
	regularVoterCount: 0,
	regularVoterRate: 0,
	generatedAt: nowIso(),
});

const getCurrentOpinionModel = ({ surveyType, survey }) => {
	const isFlashSurvey = survey?.explain === false;
	if (surveyType === 'multiple') {
		return isFlashSurvey ? Opinion_2_Flash : Opinion_2;
	}
	return isFlashSurvey ? Opinion_Flash : Opinion;
};

const listOwnerSurveyIds = async (ownerUserId) => {
	const [binarySurveys, multipleSurveys] = await Promise.all([
		Survey.find({ userId: ownerUserId }).select('_id').lean(),
		Survey_2.find({ userId: ownerUserId }).select('_id').lean(),
	]);

	return {
		binarySurveyIds: toUniqueByStringValue(binarySurveys.map((item) => item?._id).filter(Boolean)),
		multipleSurveyIds: toUniqueByStringValue(
			multipleSurveys.map((item) => item?._id).filter(Boolean),
		),
	};
};

const mergeDistinctSurveyCounts = async ({
	opinionModel,
	surveyIds,
	participantIds,
	accumulator,
	surveyNamespace,
}) => {
	if (!opinionModel || !surveyIds?.length || !participantIds?.length) return;

	const participantChunks = chunkArray(participantIds, PARTICIPANT_CHUNK_SIZE);
	const surveyChunks =
		surveyIds.length > SURVEY_CHUNK_SIZE ?
			chunkArray(surveyIds, SURVEY_CHUNK_SIZE)
		:	[surveyIds];

	for (const surveyChunk of surveyChunks) {
		for (const participantChunk of participantChunks) {
			const rows = await opinionModel
				.aggregate([
					{
						$match: {
							surveyId: { $in: surveyChunk },
							userId: { $in: participantChunk },
						},
					},
					{
						$group: {
							_id: '$userId',
							surveyIds: { $addToSet: '$surveyId' },
						},
					},
				])
				.option({ allowDiskUse: true });

			for (const row of rows) {
				const participantKey = String(row?._id || '').trim();
				if (!participantKey) continue;

				if (!accumulator.has(participantKey)) {
					accumulator.set(participantKey, new Set());
				}
				const participantSurveySet = accumulator.get(participantKey);
				for (const surveyId of row?.surveyIds || []) {
					participantSurveySet.add(`${surveyNamespace}:${String(surveyId)}`);
				}
			}
		}
	}
};

const buildRegularVoterInsight = async ({ survey, surveyType, threshold } = {}) => {
	const normalizedThreshold = normalizeRegularVoterThreshold(
		threshold ?? process.env.EXPORT_REGULAR_VOTER_MIN_SURVEYS,
	);

	if (!survey?._id || !survey?.userId) {
		return buildUnavailableRegularVoterInsight({
			threshold: normalizedThreshold,
			errorCode: 'INVALID_SURVEY_INPUT',
		});
	}

	const currentOpinionModel = getCurrentOpinionModel({ surveyType, survey });
	const participantIds = toUniqueByStringValue(
		await currentOpinionModel.distinct('userId', { surveyId: survey._id }),
	);

	if (!participantIds.length) {
		return buildEmptyRegularVoterInsight({
			threshold: normalizedThreshold,
			participantCount: 0,
		});
	}

	const { binarySurveyIds, multipleSurveyIds } = await listOwnerSurveyIds(survey.userId);
	if (!binarySurveyIds.length && !multipleSurveyIds.length) {
		return buildEmptyRegularVoterInsight({
			threshold: normalizedThreshold,
			participantCount: participantIds.length,
		});
	}

	const surveyCountsByParticipant = new Map();
	await Promise.all([
		mergeDistinctSurveyCounts({
			opinionModel: Opinion,
			surveyIds: binarySurveyIds,
			participantIds,
			accumulator: surveyCountsByParticipant,
			surveyNamespace: 'binary',
		}),
		mergeDistinctSurveyCounts({
			opinionModel: Opinion_Flash,
			surveyIds: binarySurveyIds,
			participantIds,
			accumulator: surveyCountsByParticipant,
			surveyNamespace: 'binary',
		}),
		mergeDistinctSurveyCounts({
			opinionModel: Opinion_2,
			surveyIds: multipleSurveyIds,
			participantIds,
			accumulator: surveyCountsByParticipant,
			surveyNamespace: 'multiple',
		}),
		mergeDistinctSurveyCounts({
			opinionModel: Opinion_2_Flash,
			surveyIds: multipleSurveyIds,
			participantIds,
			accumulator: surveyCountsByParticipant,
			surveyNamespace: 'multiple',
		}),
	]);

	let regularVoterCount = 0;
	for (const participantId of participantIds) {
		const participantKey = String(participantId || '').trim();
		if (!participantKey) continue;
		const surveySet = surveyCountsByParticipant.get(participantKey);
		if ((surveySet?.size || 0) >= normalizedThreshold) {
			regularVoterCount += 1;
		}
	}

	const participantCount = participantIds.length;
	const regularVoterRate =
		participantCount > 0 ?
			Number(((regularVoterCount / participantCount) * 100).toFixed(2))
		:	0;

	return {
		status: 'ok',
		scope: 'creator_surveys',
		population: 'current_survey_participants',
		includeCurrentSurvey: true,
		thresholdMinSurveys: normalizedThreshold,
		participantCount,
		regularVoterCount,
		regularVoterRate,
		generatedAt: nowIso(),
	};
};

module.exports = {
	buildRegularVoterInsight,
	buildUnavailableRegularVoterInsight,
	normalizeRegularVoterThreshold,
};
