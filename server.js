/** @format */
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const app = require('./app');
const chatHandlers = require('./sockets/chatHandlers');
const supportHandlers = require('./sockets/supportHandlers');
const flashSurveyHandlers = require('./sockets/flashSurveyHandlers');
const classicSurveyHandlers = require('./sockets/classicSurveyHandlers');
const surveyFeedHandlers = require('./sockets/surveyFeedHandlers');
const broadcastHandlers = require('./sockets/broadcastHandlers');
const { getRedisClient, getRedisSubscriber } = require('./services/redisService');
const { registerBillingLifecycleJob } = require('./services/billing/billingLifecycleJob');
const { registerFraudGraphJob } = require('./services/fraud/fraudGraphJobService');
const { primeContentModeration } = require('./services/contentModerationService');

const normalizePort = (val) => {
	const port = parseInt(val, 10);
	if (Number.isNaN(port)) return val;
	if (port >= 0) return port;
	return false;
};

const port = normalizePort(process.env.PORT || '3000');
app.set('port', port);

const server = http.createServer(app);

const io = new Server(server, {
	cors: { origin: '*' },
});
app.set('io', io);

const configureSocketAdapter = async () => {
	try {
		const redisPub = await getRedisClient();
		const redisSub = await getRedisSubscriber();
		if (!redisPub || !redisSub) {
			console.log('Socket adapter Redis desactive (REDIS_URL absent).');
			return;
		}
		io.adapter(createAdapter(redisPub, redisSub));
		console.log('Socket adapter Redis active.');
	} catch (error) {
		console.error('Socket adapter Redis init failed:', error?.message || error);
	}
};

chatHandlers(io);
flashSurveyHandlers(io);
classicSurveyHandlers(io);
surveyFeedHandlers(io);
broadcastHandlers(io);
supportHandlers(io.of('/support'));

io.on('connection', (socket) => {
	console.log('Client Socket.IO connecte', socket.id);
	socket.on('disconnect', () => {
		console.log('Client deconnecte', socket.id);
	});
});

const errorHandler = (error) => {
	if (error.syscall !== 'listen') throw error;
	const address = server.address();
	const bind = typeof address === 'string' ? 'pipe ' + address : 'port: ' + port;
	switch (error.code) {
		case 'EACCES':
			console.error(bind + ' requires elevated privileges.');
			process.exit(1);
			break;
		case 'EADDRINUSE':
			console.error(bind + ' is already in use.');
			process.exit(1);
			break;
		default:
			throw error;
	}
};

server.on('error', errorHandler);
server.on('listening', () => {
	const address = server.address();
	const bind = typeof address === 'string' ? 'pipe ' + address : 'port ' + port;
	console.log('Listening on ' + bind);
});

const start = async () => {
	await configureSocketAdapter();
	registerBillingLifecycleJob();
	registerFraudGraphJob();
	try {
		await primeContentModeration();
	} catch (error) {
		console.error(
			'Content moderation warmup failed:',
			error?.message || error,
		);
	}
	server.listen(port);
};

start().catch((error) => {
	console.error('Server startup failed:', error);
	process.exit(1);
});
