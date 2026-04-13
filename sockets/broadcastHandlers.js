/** @format */

const jwt = require('jsonwebtoken');

const User = require('../models/User');
const {
	resolveBroadcastSurveyContext,
	assertUserCanManageBroadcastSurvey,
} = require('../services/broadcastCandidateService');
const {
	validateBroadcastSessionToken,
} = require('../services/broadcastSessionService');
const {
	buildBroadcastSurveyRoomName,
	buildBroadcastStudioRoomName,
	buildBroadcastSessionRoomName,
} = require('../services/broadcastRealtimeService');

const extractSocketUserToken = (socket) => {
	const authToken = socket?.handshake?.auth?.token;
	if (authToken) return String(authToken).trim();
	const queryToken = socket?.handshake?.query?.token;
	if (queryToken) return String(queryToken).trim();
	const authHeader = socket?.handshake?.headers?.authorization;
	if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
		return authHeader.slice(7).trim();
	}
	return null;
};

const resolveSocketUser = async (socket) => {
	if (socket?.data?.authUser) return socket.data.authUser;
	const token = extractSocketUserToken(socket);
	if (!token) return null;
	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) return null;
		const user = await User.findById(decoded.id)
			.select('_id pseudo email role picture defaultOrganizationId')
			.lean();
		if (!user) return null;
		const authUser = {
			id: String(user._id),
			pseudo: user.pseudo || decoded.pseudo || 'Utilisateur',
			email: user.email || decoded.email || null,
			role: user.role || decoded.role || 'user',
			picture: user.picture || null,
			defaultOrganizationId: user.defaultOrganizationId || null,
		};
		socket.data.authUser = authUser;
		return authUser;
	} catch (_error) {
		return null;
	}
};

const extractBroadcastTokenFromSocket = (socket, payload = {}) => {
	const payloadToken = payload?.token;
	if (payloadToken) return String(payloadToken).trim();
	const authToken = socket?.handshake?.auth?.broadcastToken;
	if (authToken) return String(authToken).trim();
	const queryToken = socket?.handshake?.query?.broadcastToken;
	if (queryToken) return String(queryToken).trim();
	return null;
};

module.exports = (io) => {
	io.on('connection', (socket) => {
		socket.on('broadcast:joinStudio', async (payload = {}, ack) => {
			try {
				const authUser = await resolveSocketUser(socket);
				if (!authUser?.id) {
					throw Object.assign(new Error('Authentification requise.'), { status: 401 });
				}
				const surveyContext = await resolveBroadcastSurveyContext(payload?.surveyId);
				await assertUserCanManageBroadcastSurvey({
					surveyContext,
					userId: authUser.id,
				});
				await socket.join(buildBroadcastStudioRoomName(surveyContext.survey._id));
				await socket.join(buildBroadcastSurveyRoomName(surveyContext.survey._id));
				socket.data.broadcastStudioSurveyId = String(surveyContext.survey._id);
				ack?.({ ok: true, surveyId: String(surveyContext.survey._id) });
			} catch (error) {
				ack?.({ ok: false, message: String(error?.message || 'Acces refuse.') });
			}
		});

		socket.on('broadcast:leaveStudio', async (_payload = {}, ack) => {
			const surveyId = socket?.data?.broadcastStudioSurveyId;
			if (surveyId) {
				await socket.leave(buildBroadcastStudioRoomName(surveyId));
				await socket.leave(buildBroadcastSurveyRoomName(surveyId));
				socket.data.broadcastStudioSurveyId = null;
			}
			ack?.({ ok: true });
		});

		socket.on('broadcast:joinOverlay', async (payload = {}, ack) => {
			try {
				const token = extractBroadcastTokenFromSocket(socket, payload);
				const { session } = await validateBroadcastSessionToken({
					token,
					output: 'overlay',
					touch: false,
				});
				await socket.join(buildBroadcastSurveyRoomName(session.surveyId));
				await socket.join(buildBroadcastSessionRoomName(session._id));
				socket.data.broadcastOverlaySessionId = String(session._id);
				socket.data.broadcastOverlaySurveyId = String(session.surveyId);
				ack?.({
					ok: true,
					sessionId: String(session._id),
					surveyId: String(session.surveyId),
					mode: session.mode,
				});
			} catch (error) {
				ack?.({ ok: false, message: String(error?.message || 'Session broadcast invalide.') });
			}
		});

		socket.on('broadcast:leaveOverlay', async (_payload = {}, ack) => {
			const surveyId = socket?.data?.broadcastOverlaySurveyId;
			const sessionId = socket?.data?.broadcastOverlaySessionId;
			if (surveyId) {
				await socket.leave(buildBroadcastSurveyRoomName(surveyId));
				socket.data.broadcastOverlaySurveyId = null;
			}
			if (sessionId) {
				await socket.leave(buildBroadcastSessionRoomName(sessionId));
				socket.data.broadcastOverlaySessionId = null;
			}
			ack?.({ ok: true });
		});
	});
};

