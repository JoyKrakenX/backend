/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');

const resolveBackendModule = (relativePath) =>
	require.resolve(path.join(backendRoot, relativePath));

const setMockModule = (relativePath, exportsValue) => {
	const modulePath = resolveBackendModule(relativePath);
	const previous = require.cache[modulePath];
	require.cache[modulePath] = {
		id: modulePath,
		filename: modulePath,
		loaded: true,
		exports: exportsValue,
	};
	return () => {
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	};
};

const createResponseDouble = () => {
	const res = {
		statusCode: 200,
		payload: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.payload = payload;
			return this;
		},
	};
	return res;
};

test('reviewQuarantineOpinion logs quarantine_review audit event', async () => {
	const surveyId = '507f1f77bcf86cd799439011';
	const opinionId = '507f1f77bcf86cd799439012';
	const userId = '507f1f77bcf86cd799439013';
	const organizationId = '507f1f77bcf86cd799439014';

	const logCalls = [];
	const opinionDoc = {
		_id: opinionId,
		surveyId,
		fraudStatus: 'quarantined',
		fraudReasons: ['RISK_SCORE_ABOVE_QUARANTINE'],
		challengeType: 'none',
		fraudScore: 54,
		ipHash: 'ip-hash',
		deviceHash: 'device-hash',
		reviewedBy: null,
		reviewedAt: null,
		save: async () => {},
	};

	const cleanups = [];
	try {
		cleanups.push(
			setMockModule('models/Survey.js', {
				findById: () => ({
					select: () => ({
						lean: async () => ({
							_id: surveyId,
							explain: true,
							userId,
							organizationId,
							isClosed: false,
							status: 'open',
							createdAt: new Date('2026-01-01T00:00:00.000Z'),
							endedAt: null,
						}),
					}),
				}),
			}),
		);
		cleanups.push(
			setMockModule('models/Opinion.js', {
				modelName: 'Opinion',
				findOne: async () => opinionDoc,
				countDocuments: async (filter = {}) => (filter?.answer === true ? 2 : 1),
			}),
		);
		cleanups.push(
			setMockModule('models/Opinion_Flash.js', {
				modelName: 'Opinion_Flash',
				findOne: async () => null,
				countDocuments: async () => 0,
			}),
		);
		cleanups.push(
			setMockModule('services/fraud/fraudDecisionLogService.js', {
				logFraudDecision: async (payload) => {
					logCalls.push(payload);
				},
			}),
		);
		cleanups.push(
			setMockModule('services/fraud/opinionFilterService.js', {
				buildStatusFilter: () => ({ fraudStatus: { $in: ['accepted', 'released'] } }),
				getIntegritySnapshotForSurvey: async () => ({
					rawCounts: 4,
					cleanCounts: 3,
					quarantinedCounts: 1,
					confirmedFraudCounts: 0,
					confidenceScore: 75,
					topRiskSignals: [{ code: 'RISK_SCORE_ABOVE_QUARANTINE', count: 1 }],
				}),
			}),
		);
		cleanups.push(
			setMockModule('services/surveyOrganizationService.js', {
				resolveSurveyOrganizationId: async () => organizationId,
			}),
		);
		cleanups.push(
			setMockModule('sockets/surveyFeedHandlers.js', {
				emitSurveyFeedUpdate: () => null,
			}),
		);

		const controllerPath = resolveBackendModule('controllers/survey.js');
		delete require.cache[controllerPath];
		const surveyController = require(path.join(backendRoot, 'controllers/survey.js'));

		const ioStub = {
			to: () => ({ emit: () => {} }),
			surveyFeedConnectedUsers: new Map(),
		};
		const req = {
			params: {
				id: surveyId,
				opinionId,
			},
			body: {
				action: 'release',
			},
			userId,
			app: {
				get: (key) => (key === 'io' ? ioStub : null),
			},
		};
		const res = createResponseDouble();

		await surveyController.reviewQuarantineOpinion(req, res);

		assert.equal(res.statusCode, 200);
		assert.equal(res.payload?.status, 'released');
		assert.equal(opinionDoc.fraudStatus, 'released');
		assert.equal(logCalls.length, 1);
		assert.equal(logCalls[0]?.event, 'quarantine_review');
		assert.equal(logCalls[0]?.decision, 'released');
		assert.equal(logCalls[0]?.meta?.action, 'release');
	} finally {
		delete require.cache[resolveBackendModule('controllers/survey.js')];
		for (const restore of cleanups.reverse()) {
			try {
				restore();
			} catch (_error) {}
		}
	}
});
