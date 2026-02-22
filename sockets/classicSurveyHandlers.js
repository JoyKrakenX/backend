/** @format */

const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');

const normalizeType = (value) => {
	if (value === 'binary' || value === 'multiple') return value;
	return null;
};

const buildRoomName = ({ surveyId, type }) => `classic-${type}-${String(surveyId)}`;

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

		return {
			id: String(decoded.id),
			role: String(decoded.role || 'user'),
		};
	} catch (_error) {
		return null;
	}
};

const resolveModelsByType = (type) =>
	type === 'binary' ?
		{ SurveyModel: Survey, OpinionModel: Opinion }
	:	{ SurveyModel: Survey_2, OpinionModel: Opinion_2 };

const canJoinClassicRoom = async ({ surveyId, type, user }) => {
	if (!surveyId || !mongoose.Types.ObjectId.isValid(String(surveyId))) {
		return {
			allowed: false,
			message: 'Identifiant de sondage invalide.',
		};
	}

	const { SurveyModel, OpinionModel } = resolveModelsByType(type);
	const survey = await SurveyModel.findById(surveyId)
		.select('userId explain')
		.lean();
	if (!survey) {
		return { allowed: false, message: 'Sondage introuvable.' };
	}

	if (survey.explain === false) {
		return {
			allowed: false,
			message: 'Ce sondage utilise le canal Flash.',
		};
	}

	const isOwner = String(survey.userId) === String(user.id);
	const isAdmin = user.role === 'admin';
	if (isOwner || isAdmin) {
		return { allowed: true };
	}

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

const clearClassicSocketState = (socket) => {
	socket.data.classicRoom = null;
	socket.data.classicSurveyId = null;
	socket.data.classicType = null;
};

const classicSurveyHandlers = (io) => {
	io.on('connection', (socket) => {
		socket.on('classic:join', async ({ surveyId, type } = {}) => {
			const normalizedType = normalizeType(type);
			if (!normalizedType || !surveyId) {
				socket.emit('classic:error', {
					code: 'INVALID_PAYLOAD',
					message: 'Parametres de connexion invalides.',
				});
				return;
			}

			const user = extractSocketUser(socket);
			if (!user) {
				socket.emit('classic:error', {
					code: 'UNAUTHORIZED',
					message: 'Authentification requise pour le live.',
				});
				return;
			}

			try {
				const access = await canJoinClassicRoom({
					surveyId,
					type: normalizedType,
					user,
				});
				if (!access.allowed) {
					socket.emit('classic:error', {
						code: 'FORBIDDEN',
						message: access.message,
					});
					return;
				}

				const room = buildRoomName({ surveyId, type: normalizedType });
				if (socket.data?.classicRoom && socket.data.classicRoom !== room) {
					socket.leave(socket.data.classicRoom);
				}

				socket.join(room);
				socket.data.classicRoom = room;
				socket.data.classicSurveyId = String(surveyId);
				socket.data.classicType = normalizedType;
			} catch (error) {
				console.error('classic:join error:', error);
				socket.emit('classic:error', {
					code: 'SERVER_ERROR',
					message: 'Impossible de rejoindre le live.',
				});
			}
		});

		socket.on('classic:leave', ({ surveyId, type } = {}) => {
			const normalizedType = normalizeType(type);
			if (!normalizedType || !surveyId) return;

			const expectedRoom = buildRoomName({ surveyId, type: normalizedType });
			if (socket.data?.classicRoom === expectedRoom) {
				socket.leave(expectedRoom);
				clearClassicSocketState(socket);
			}
		});

		socket.on('disconnect', () => {
			if (socket.data?.classicRoom) {
				socket.leave(socket.data.classicRoom);
				clearClassicSocketState(socket);
			}
		});
	});
};

module.exports = classicSurveyHandlers;
