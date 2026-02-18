/** @format */

module.exports = (io) => {
	io.on('connection', (socket) => {
		socket.on('flash:join', ({ surveyId, type } = {}) => {
			if (!surveyId || (type !== 'binary' && type !== 'multiple')) {
				return;
			}

			const room =
				type === 'binary' ?
					`flash-binary-${surveyId}`
				:	`flash-multiple-${surveyId}`;

			if (socket.data?.flashRoom && socket.data.flashRoom !== room) {
				socket.leave(socket.data.flashRoom);
			}

			socket.join(room);
			socket.data.flashRoom = room;
			socket.data.flashSurveyId = String(surveyId);
			socket.data.flashType = type;
		});

		socket.on('flash:leave', ({ surveyId, type } = {}) => {
			const expectedRoom =
				type === 'multiple' ?
					`flash-multiple-${surveyId}`
				:	`flash-binary-${surveyId}`;
			if (socket.data?.flashRoom === expectedRoom) {
				socket.leave(expectedRoom);
				socket.data.flashRoom = null;
				socket.data.flashSurveyId = null;
				socket.data.flashType = null;
			}
		});

		socket.on('disconnect', () => {
			if (socket.data?.flashRoom) {
				socket.leave(socket.data.flashRoom);
				socket.data.flashRoom = null;
				socket.data.flashSurveyId = null;
				socket.data.flashType = null;
			}
		});
	});
};
