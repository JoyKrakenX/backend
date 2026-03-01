/** @format */

const Redis = require('ioredis');

let redisClient = null;
let redisSubscriber = null;

const createRedisClient = (purpose = 'default') => {
	const redisUrl = String(process.env.REDIS_URL || '').trim();
	if (!redisUrl) return null;
	const client = new Redis(redisUrl, {
		maxRetriesPerRequest: null,
		enableReadyCheck: false,
		lazyConnect: true,
	});
	client.on('error', (error) => {
		console.error(`redis[${purpose}] error:`, error?.message || error);
	});
	return client;
};

const getRedisClient = async () => {
	if (redisClient) return redisClient;
	redisClient = createRedisClient('main');
	if (!redisClient) return null;
	await redisClient.connect();
	return redisClient;
};

const getRedisSubscriber = async () => {
	if (redisSubscriber) return redisSubscriber;
	redisSubscriber = createRedisClient('subscriber');
	if (!redisSubscriber) return null;
	await redisSubscriber.connect();
	return redisSubscriber;
};

module.exports = {
	getRedisClient,
	getRedisSubscriber,
};
