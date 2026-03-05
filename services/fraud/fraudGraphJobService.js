/** @format */

const cron = require('node-cron');
const { UndirectedGraph } = require('graphology');
const louvain = require('graphology-communities-louvain');

const Opinion = require('../../models/Opinion');
const Opinion2 = require('../../models/Opinion_2');
const OpinionFlash = require('../../models/Opinion_Flash');
const Opinion2Flash = require('../../models/Opinion_2_Flash');
const { getRedisClient } = require('../redisService');
const { logFraudDecision } = require('./fraudDecisionLogService');
const { FRAUD_CONFIG, parseBoolean } = require('../../utils/fraudConfig');

const OPINION_MODELS = [Opinion, Opinion2, OpinionFlash, Opinion2Flash];

const GRAPH_USER_KEY_PREFIX = 'fraud:graph:user';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const addNodeIfMissing = (graph, nodeKey, attributes) => {
	if (!graph.hasNode(nodeKey)) {
		graph.addNode(nodeKey, attributes);
	}
};

const addEdgeIfMissing = (graph, source, target) => {
	if (!graph.hasEdge(source, target)) {
		graph.addUndirectedEdge(source, target);
	}
};

const loadSignals = async ({ fromDate }) => {
	const docs = await Promise.all(
		OPINION_MODELS.map((Model) =>
			Model.find({
				createdAt: { $gte: fromDate },
				$or: [{ ipHash: { $ne: null } }, { deviceHash: { $ne: null } }],
			})
				.select('userId ipHash deviceHash')
				.lean(),
		),
	);

	return docs.flat();
};

const computeCommunityRisk = ({ userCount, signalCount, edgeCount }) => {
	const density = userCount > 0 ? edgeCount / userCount : 0;
	const fUsers = clamp(userCount / 25, 0, 1);
	const fSignals = clamp(signalCount / 25, 0, 1);
	const fDensity = clamp(density / 6, 0, 1);
	return Math.round(clamp(0.55 * fUsers + 0.2 * fSignals + 0.25 * fDensity, 0, 1) * 100);
};

const runFraudGraphJob = async ({ windowDays = 30, quarantineThreshold = 85 } = {}) => {
	if (!FRAUD_CONFIG.enabled) {
		return {
			skipped: true,
			reason: 'FRAUD_DISABLED',
		};
	}

	const redis = await getRedisClient();
	if (!redis) {
		return {
			skipped: true,
			reason: 'REDIS_UNAVAILABLE',
		};
	}

	const fromDate = new Date(Date.now() - Number(windowDays || 30) * 24 * 60 * 60 * 1000);
	const rows = await loadSignals({ fromDate });
	if (!rows.length) {
		return {
			skipped: false,
			rows: 0,
			updatedUsers: 0,
			retroQuarantined: 0,
		};
	}

	const graph = new UndirectedGraph();

	rows.forEach((entry) => {
		const userId = String(entry?.userId || '').trim();
		if (!userId) return;
		const userNode = `user:${userId}`;
		addNodeIfMissing(graph, userNode, { type: 'user', userId });

		const ipHash = String(entry?.ipHash || '').trim();
		if (ipHash) {
			const ipNode = `ip:${ipHash}`;
			addNodeIfMissing(graph, ipNode, { type: 'ip', value: ipHash });
			addEdgeIfMissing(graph, userNode, ipNode);
		}

		const deviceHash = String(entry?.deviceHash || '').trim();
		if (deviceHash) {
			const deviceNode = `device:${deviceHash}`;
			addNodeIfMissing(graph, deviceNode, { type: 'device', value: deviceHash });
			addEdgeIfMissing(graph, userNode, deviceNode);
		}
	});

	if (graph.order === 0) {
		return {
			skipped: false,
			rows: rows.length,
			updatedUsers: 0,
			retroQuarantined: 0,
		};
	}

	const communities = louvain(graph);
	const buckets = new Map();

	graph.forEachNode((node) => {
		const communityId = communities[node];
		const bucket =
			buckets.get(communityId) || {
				users: new Set(),
				signals: new Set(),
				edges: 0,
			};
		const attrs = graph.getNodeAttributes(node);
		if (attrs?.type === 'user') {
			bucket.users.add(String(attrs.userId));
		} else {
			bucket.signals.add(node);
		}
		buckets.set(communityId, bucket);
	});

	graph.forEachEdge((edge, attrs, source, target) => {
		const communityId = communities[source];
		if (communityId !== communities[target]) return;
		const bucket = buckets.get(communityId);
		if (!bucket) return;
		bucket.edges += 1;
	});

	const userRiskMap = new Map();
	for (const bucket of buckets.values()) {
		const userCount = bucket.users.size;
		const signalCount = bucket.signals.size;
		const edgeCount = Number(bucket.edges || 0);
		const communityRisk = computeCommunityRisk({ userCount, signalCount, edgeCount });
		bucket.users.forEach((userId) => {
			const previous = Number(userRiskMap.get(userId) || 0);
			userRiskMap.set(userId, Math.max(previous, communityRisk));
		});
	}

	const pipe = redis.pipeline();
	for (const [userId, riskScore] of userRiskMap.entries()) {
		pipe.set(
			`${GRAPH_USER_KEY_PREFIX}:${String(userId)}`,
			String(Math.round(clamp(riskScore, 0, 100))),
			'EX',
			6 * 60 * 60,
		);
	}
	await pipe.exec();

	const highRiskUsers = [...userRiskMap.entries()]
		.filter(([, score]) => Number(score) >= Number(quarantineThreshold || 85))
		.map(([userId]) => userId);

	let retroQuarantined = 0;
	if (highRiskUsers.length) {
		const updates = await Promise.all(
			OPINION_MODELS.map((Model) =>
				Model.updateMany(
					{
						userId: { $in: highRiskUsers },
						fraudStatus: 'accepted',
					},
					{
						$set: {
							fraudStatus: 'quarantined',
							reviewedAt: new Date(),
						},
						$addToSet: {
							fraudReasons: 'BATCH_GRAPH_HIGH_RISK',
						},
					},
				),
			),
		);
		retroQuarantined = updates.reduce(
			(sum, entry) => sum + Number(entry?.modifiedCount || 0),
			0,
		);
	}

	await logFraudDecision({
		event: 'batch_retro_quarantine',
		decision: 'quarantined',
		actionType: 'batch',
		riskScore: 0,
		reasons: ['GRAPH_BATCH_COMPLETED'],
		challengeType: 'none',
		meta: {
			rows: rows.length,
			updatedUsers: userRiskMap.size,
			highRiskUsers: highRiskUsers.length,
			retroQuarantined,
			windowDays,
		},
	});

	return {
		skipped: false,
		rows: rows.length,
		updatedUsers: userRiskMap.size,
		highRiskUsers: highRiskUsers.length,
		retroQuarantined,
	};
};

const registerFraudGraphJob = () => {
	const enabled = parseBoolean(process.env.FRAUD_GRAPH_JOB_ENABLED, true);
	if (!enabled) return;

	cron.schedule('0 * * * *', () => {
		runFraudGraphJob().catch((error) => {
			console.error('fraudGraphJob failed:', error?.message || error);
		});
	});
};

module.exports = {
	runFraudGraphJob,
	registerFraudGraphJob,
};
