/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const OpinionFlash = require('../models/Opinion_Flash');
const Opinion2Flash = require('../models/Opinion_2_Flash');
const { canManageSurveyByOrganization } = require('../services/surveyAuthorizationService');

const normalizeType = (value) => {
	if (value === 'binary' || value === 'multiple') return value;
	return null;
};

const buildRoomName = ({ surveyId, type }) =>
	type === 'multiple' ?
		`flash-multiple-${String(surveyId)}`
	:	`flash-binary-${String(surveyId)}`;

const extractSocketToken = (socket) => {
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

const extractSocketUser = (socket) => {
	const token = extractSocketToken(socket);
	if (!token) return null;

	try {
		const decoded = jwt.verify(token, process.env.JWT_SECRET);
		if (!decoded?.id) return null;
		return { id: String(decoded.id) };
	} catch (_error) {
		return null;
	}
};

const resolveModelsByType = (type) =>
	type === 'multiple' ?
		{
			SurveyModel: Survey_2,
			OpinionModel: Opinion2Flash,
		}
	:	{
			SurveyModel: Survey,
			OpinionModel: OpinionFlash,
		};

const canJoinFlashRoom = async ({ surveyId, type, user }) => {
	if (!surveyId || !mongoose.Types.ObjectId.isValid(String(surveyId))) {
		return {
			allowed: false,
			message: 'Identifiant de sondage invalide.',
		};
	}

	const { SurveyModel, OpinionModel } = resolveModelsByType(type);
	const survey = await SurveyModel.findById(surveyId)
		.select('_id userId organizationId explain')
		.lean();
	if (!survey) {
		return {
			allowed: false,
			message: 'Sondage introuvable.',
		};
	}

	if (survey.explain !== false) {
		return {
			allowed: false,
			message: 'Ce sondage utilise le canal classique.',
		};
	}

	const isOwner = String(survey.userId || '') === String(user.id || '');
	if (isOwner) return { allowed: true };

	const canManage = await canManageSurveyByOrganization(survey, user.id);
	if (canManage) return { allowed: true };

	const hasParticipated = Boolean(
		await OpinionModel.findOne({
			surveyId: survey._id,
			userId: user.id,
		})
			.select('_id')
			.lean(),
	);
	if (!hasParticipated) {
		return {
			allowed: false,
			message: 'Votez pour acceder aux resultats en temps reel.',
		};
	}

	return { allowed: true };
};

const clearFlashSocketState = (socket) => {
	socket.data.flashRoom = null;
	socket.data.flashSurveyId = null;
	socket.data.flashType = null;
};

module.exports = (io) => {
	io.on('connection', (socket) => {
		socket.on('flash:join', async ({ surveyId, type } = {}) => {
			const normalizedType = normalizeType(type);
			if (!surveyId || !normalizedType) {
				socket.emit('flash:error', {
					code: 'INVALID_PAYLOAD',
					message: 'Parametres de connexion invalides.',
				});
				return;
			}

			const user = extractSocketUser(socket);
			if (!user) {
				socket.emit('flash:error', {
					code: 'UNAUTHORIZED',
					message: 'Authentification requise pour le live.',
				});
				return;
			}

			try {
				const access = await canJoinFlashRoom({
					surveyId,
					type: normalizedType,
					user,
				});
				if (!access.allowed) {
					socket.emit('flash:error', {
						code: 'FORBIDDEN',
						message: access.message,
					});
					return;
				}

				const room = buildRoomName({ surveyId, type: normalizedType });
				if (socket.data?.flashRoom && socket.data.flashRoom !== room) {
					socket.leave(socket.data.flashRoom);
				}

				socket.join(room);
				socket.data.flashRoom = room;
				socket.data.flashSurveyId = String(surveyId);
				socket.data.flashType = normalizedType;
			} catch (error) {
				console.error('flash:join error:', error);
				socket.emit('flash:error', {
					code: 'SERVER_ERROR',
					message: 'Impossible de rejoindre le live.',
				});
			}
		});

		socket.on('flash:leave', ({ surveyId, type } = {}) => {
			const normalizedType = normalizeType(type);
			if (!surveyId || !normalizedType) return;
			const expectedRoom = buildRoomName({ surveyId, type: normalizedType });
			if (socket.data?.flashRoom === expectedRoom) {
				socket.leave(expectedRoom);
				clearFlashSocketState(socket);
			}
		});

		socket.on('disconnect', () => {
			if (socket.data?.flashRoom) {
				socket.leave(socket.data.flashRoom);
				clearFlashSocketState(socket);
			}
		});
	});
};
