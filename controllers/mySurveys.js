/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
const OrganizationMember = require('../models/OrganizationMember');
const { normalizeSurveyStatus } = require('../utils/surveyStatus');

const MANAGER_ROLES = ['owner', 'admin'];
const SURVEY_LIST_PROJECTION =
	'_id theme question contexte explain status createdAt userId organizationId isClosed endedAt';

const toSurveyIds = (surveys) =>
	Array.isArray(surveys) ? surveys.map((survey) => survey?._id).filter(Boolean) : [];

const countOpinionsBySurvey = async (OpinionModel, surveyIds = []) => {
	if (!surveyIds.length) return new Map();
	const rows = await OpinionModel.aggregate([
		{
			$match: {
				surveyId: { $in: surveyIds },
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

const buildIdentityKey = (survey, type) =>
	`${type}:${String(survey?._id || '').trim()}`;

const dedupeSurveys = (surveys = [], type) => {
	const seen = new Set();
	const deduped = [];

	for (const survey of Array.isArray(surveys) ? surveys : []) {
		const key = buildIdentityKey(survey, type);
		if (!key || key.endsWith(':')) continue;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(survey);
	}

	return deduped;
};

const sortByCreatedAtDesc = (left, right) =>
	new Date(right?.createdAt || 0) - new Date(left?.createdAt || 0);

const formatSurveyEntry = ({
	survey,
	type,
	voteCount,
	viewerUserId,
	scope = 'creator',
	canManage = false,
}) => {
	const isCreator = String(survey?.userId || '') === String(viewerUserId || '');
	const normalizedCanManage = Boolean(canManage || isCreator);

	return {
		...survey,
		status: normalizeSurveyStatus(survey?.status),
		type,
		totalVotes: Number(voteCount || 0),
		opinionsCount: Number(voteCount || 0),
		scope,
		isCreator,
		canManage: normalizedCanManage,
		canClose: isCreator,
		organizationId: survey?.organizationId || null,
	};
};

const computeVoteMaps = async ({ binary = [], multiple = [] }) => {
	const binaryClassic = binary.filter((survey) => survey.explain !== false);
	const binaryFlash = binary.filter((survey) => survey.explain === false);
	const multipleClassic = multiple.filter((survey) => survey.explain !== false);
	const multipleFlash = multiple.filter((survey) => survey.explain === false);

	const [
		binaryClassicCounts,
		binaryFlashCounts,
		multipleClassicCounts,
		multipleFlashCounts,
	] = await Promise.all([
		countOpinionsBySurvey(Opinion, toSurveyIds(binaryClassic)),
		countOpinionsBySurvey(Opinion_Flash, toSurveyIds(binaryFlash)),
		countOpinionsBySurvey(Opinion_2, toSurveyIds(multipleClassic)),
		countOpinionsBySurvey(Opinion_2_Flash, toSurveyIds(multipleFlash)),
	]);

	return {
		binaryClassicCounts,
		binaryFlashCounts,
		multipleClassicCounts,
		multipleFlashCounts,
	};
};

const getVoteCount = ({ survey, type, voteMaps }) => {
	const surveyId = String(survey?._id || '');
	if (!surveyId) return 0;

	if (type === 'binary') {
		return survey?.explain === false ?
				Number(voteMaps.binaryFlashCounts.get(surveyId) || 0)
			:	Number(voteMaps.binaryClassicCounts.get(surveyId) || 0);
	}

	return survey?.explain === false ?
			Number(voteMaps.multipleFlashCounts.get(surveyId) || 0)
		:	Number(voteMaps.multipleClassicCounts.get(surveyId) || 0);
};

exports.getMySurveys = async (req, res, next) => {
	try {
		const userId = req.userId;
		const requestedView = String(req.query?.view || '').trim().toLowerCase();
		const dashboardView = requestedView === 'dashboard';

		const managerMemberships = await OrganizationMember.find({
			userId,
			role: { $in: MANAGER_ROLES },
		})
			.select('organizationId role')
			.lean();
		const managedOrganizationIds = [
			...new Set(
				managerMemberships
					.map((entry) => String(entry?.organizationId || '').trim())
					.filter(Boolean),
			),
		];
		const hasOrganizationAdminScope = managedOrganizationIds.length > 0;

		const [
			creatorBinaryRaw,
			creatorMultipleRaw,
			managedBinaryRaw,
			managedMultipleRaw,
		] = await Promise.all([
			Survey.find({ userId })
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.lean(),
			Survey_2.find({ userId })
				.select(SURVEY_LIST_PROJECTION)
				.sort({ createdAt: -1 })
				.lean(),
			hasOrganizationAdminScope ?
				Survey.find({ organizationId: { $in: managedOrganizationIds } })
					.select(SURVEY_LIST_PROJECTION)
					.sort({ createdAt: -1 })
					.lean()
			:	[],
			hasOrganizationAdminScope ?
				Survey_2.find({ organizationId: { $in: managedOrganizationIds } })
					.select(SURVEY_LIST_PROJECTION)
					.sort({ createdAt: -1 })
					.lean()
			:	[],
		]);

		const creatorBinary = dedupeSurveys(creatorBinaryRaw, 'binary');
		const creatorMultiple = dedupeSurveys(creatorMultipleRaw, 'multiple');
		const creatorIdentitySet = new Set([
			...creatorBinary.map((survey) => buildIdentityKey(survey, 'binary')),
			...creatorMultiple.map((survey) => buildIdentityKey(survey, 'multiple')),
		]);

		const organizationManagedBinary = dedupeSurveys(
			managedBinaryRaw.filter(
				(survey) => !creatorIdentitySet.has(buildIdentityKey(survey, 'binary')),
			),
			'binary',
		);
		const organizationManagedMultiple = dedupeSurveys(
			managedMultipleRaw.filter(
				(survey) => !creatorIdentitySet.has(buildIdentityKey(survey, 'multiple')),
			),
			'multiple',
		);

		const voteMaps = await computeVoteMaps({
			binary: [...creatorBinary, ...organizationManagedBinary],
			multiple: [...creatorMultiple, ...organizationManagedMultiple],
		});

		const creator = [
			...creatorBinary.map((survey) =>
				formatSurveyEntry({
					survey,
					type: 'binary',
					voteCount: getVoteCount({ survey, type: 'binary', voteMaps }),
					viewerUserId: userId,
					scope: 'creator',
					canManage: true,
				}),
			),
			...creatorMultiple.map((survey) =>
				formatSurveyEntry({
					survey,
					type: 'multiple',
					voteCount: getVoteCount({ survey, type: 'multiple', voteMaps }),
					viewerUserId: userId,
					scope: 'creator',
					canManage: true,
				}),
			),
		].sort(sortByCreatedAtDesc);

		if (!dashboardView) {
			return res.status(200).json(creator);
		}

		const organizationManaged = [
			...organizationManagedBinary.map((survey) =>
				formatSurveyEntry({
					survey,
					type: 'binary',
					voteCount: getVoteCount({ survey, type: 'binary', voteMaps }),
					viewerUserId: userId,
					scope: 'organization',
					canManage: true,
				}),
			),
			...organizationManagedMultiple.map((survey) =>
				formatSurveyEntry({
					survey,
					type: 'multiple',
					voteCount: getVoteCount({ survey, type: 'multiple', voteMaps }),
					viewerUserId: userId,
					scope: 'organization',
					canManage: true,
				}),
			),
		].sort(sortByCreatedAtDesc);

		return res.status(200).json({
			creator,
			organizationManaged,
			meta: {
				view: 'dashboard',
				hasOrganizationAdminScope,
				totalCreatorSurveys: creator.length,
				totalOrganizationManagedSurveys: organizationManaged.length,
				availableScopes: {
					creator: true,
					organization:
						hasOrganizationAdminScope || organizationManaged.length > 0,
				},
			},
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
