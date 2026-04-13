/** @format */

const { getBroadcastSnapshot } = require('./broadcastSnapshotService');

const buildBroadcastSurveyRoomName = (surveyId) => `broadcast-survey-${String(surveyId)}`;
const buildBroadcastStudioRoomName = (surveyId) => `broadcast-studio-${String(surveyId)}`;
const buildBroadcastSessionRoomName = (sessionId) => `broadcast-session-${String(sessionId)}`;

const emitBroadcastToSurveyRooms = (io, surveyId, eventName, payload) => {
	if (!io || !surveyId || !eventName) return;
	io.to(buildBroadcastSurveyRoomName(surveyId)).emit(eventName, payload);
	io.to(buildBroadcastStudioRoomName(surveyId)).emit(eventName, payload);
};

const emitBroadcastStatus = (io, surveyId, payload = {}) => {
	if (!io || !surveyId) return;
	emitBroadcastToSurveyRooms(io, surveyId, 'broadcast:status', {
		surveyId: String(surveyId),
		updatedAt: new Date().toISOString(),
		...payload,
	});
};

const refreshAndEmitBroadcastSnapshot = async ({ io, surveyId, surveyContext = null, reason = 'refresh' } = {}) => {
	if (!io || !surveyId) return null;
	const { snapshot, removedCueIds } = await getBroadcastSnapshot({
		surveyId,
		surveyContext,
		forceRefresh: true,
	});
	const normalizedSurveyId = String(snapshot?.survey?.id || surveyId);
	emitBroadcastToSurveyRooms(io, normalizedSurveyId, 'broadcast:results', snapshot.results);
	for (const cueId of removedCueIds || []) {
		emitBroadcastToSurveyRooms(io, normalizedSurveyId, 'broadcast:cue:remove', {
			cueId: String(cueId),
			updatedAt: snapshot.updatedAt,
			reason,
		});
	}
	for (const cue of snapshot.cues || []) {
		emitBroadcastToSurveyRooms(io, normalizedSurveyId, 'broadcast:cue:upsert', {
			cue,
			updatedAt: snapshot.updatedAt,
			reason,
		});
	}
	emitBroadcastToSurveyRooms(io, normalizedSurveyId, 'broadcast:status', {
		surveyId: normalizedSurveyId,
		updatedAt: snapshot.updatedAt,
		featuredCueId: snapshot.featuredCue?.id || null,
		cueCount: Array.isArray(snapshot.cues) ? snapshot.cues.length : 0,
		config: snapshot.config,
		reason,
	});
	return snapshot;
};

const emitBroadcastSessionRevoked = (io, session) => {
	if (!io || !session?._id) return;
	io.to(buildBroadcastSessionRoomName(session._id)).emit('broadcast:session:revoked', {
		sessionId: String(session._id),
		surveyId: String(session.surveyId || ''),
		revokedAt: new Date(session.revokedAt || Date.now()).toISOString(),
	});
};

module.exports = {
	buildBroadcastSurveyRoomName,
	buildBroadcastStudioRoomName,
	buildBroadcastSessionRoomName,
	emitBroadcastToSurveyRooms,
	emitBroadcastStatus,
	refreshAndEmitBroadcastSnapshot,
	emitBroadcastSessionRevoked,
};

