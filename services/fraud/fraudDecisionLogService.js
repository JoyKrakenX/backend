/** @format */

const mongoose = require('mongoose');

const FraudDecisionLog = require('../../models/FraudDecisionLog');

const toObjectIdOrNull = (value) => {
	if (!value) return null;
	const normalized = String(value || '').trim();
	if (!mongoose.Types.ObjectId.isValid(normalized)) return null;
	return mongoose.Types.ObjectId.createFromHexString(normalized);
};

const logFraudDecision = async (payload = {}) => {
	try {
		await FraudDecisionLog.create({
			event: String(payload.event || 'vote_decision'),
			decision: String(payload.decision || 'quarantined'),
			actionType: String(payload.actionType || 'vote'),
			userId: toObjectIdOrNull(payload.userId),
			surveyId: toObjectIdOrNull(payload.surveyId),
			surveyType: String(payload.surveyType || 'unknown'),
			opinionModel: payload.opinionModel ? String(payload.opinionModel) : null,
			ipHash: payload.ipHash ? String(payload.ipHash) : null,
			deviceHash: payload.deviceHash ? String(payload.deviceHash) : null,
			riskScore: Number(payload.riskScore || 0),
			reasons: Array.isArray(payload.reasons)
				? payload.reasons.map((entry) => String(entry)).filter(Boolean)
				: [],
			challengeType: payload.challengeType ? String(payload.challengeType) : 'none',
			metrics: payload.metrics || null,
			providerMeta: payload.providerMeta || null,
			meta: payload.meta || null,
		});
	} catch (error) {
		console.error('fraudDecision log failed:', error?.message || error);
	}
};

module.exports = {
	logFraudDecision,
};
