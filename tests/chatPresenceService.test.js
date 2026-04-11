/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	buildPresenceSocketIndexKey,
	getRedisPresenceSnapshot,
	removeSocketPresence,
	touchSocketPresence,
} = require('../services/chatPresenceService');

class FakeRedis {
	constructor() {
		this.store = new Map();
		this.sets = new Map();
	}

	_normalizeSet(key) {
		if (!this.sets.has(key)) {
			this.sets.set(key, new Set());
		}
		return this.sets.get(key);
	}

	async set(key, value) {
		this.store.set(String(key), String(value));
		return 'OK';
	}

	async del(key) {
		this.store.delete(String(key));
		return 1;
	}

	async sadd(key, value) {
		this._normalizeSet(key).add(String(value));
		return 1;
	}

	async srem(key, ...values) {
		const bucket = this._normalizeSet(key);
		values.flat().forEach((value) => bucket.delete(String(value)));
		return 1;
	}

	async smembers(key) {
		return Array.from(this._normalizeSet(key));
	}

	async expire() {
		return 1;
	}

	multi() {
		const ops = [];
		const chain = {
			set: (...args) => {
				ops.push(() => this.set(...args));
				return chain;
			},
			sadd: (...args) => {
				ops.push(() => this.sadd(...args));
				return chain;
			},
			expire: (...args) => {
				ops.push(() => this.expire(...args));
				return chain;
			},
			del: (...args) => {
				ops.push(() => this.del(...args));
				return chain;
			},
			srem: (...args) => {
				ops.push(() => this.srem(...args));
				return chain;
			},
			exec: async () => {
				for (const op of ops) {
					await op();
				}
				return [];
			},
		};
		return chain;
	}

	pipeline() {
		const keys = [];
		const chain = {
			get: (key) => {
				keys.push(String(key));
				return chain;
			},
			exec: async () => keys.map((key) => [null, this.store.get(key) || null]),
		};
		return chain;
	}
}

test('presence snapshot deduplicates multiple sockets for the same user', async () => {
	const redis = new FakeRedis();
	await touchSocketPresence(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
		socketId: 'socket-a',
		userId: 'user-1',
		pseudo: 'Alice',
		picture: null,
	});
	await touchSocketPresence(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
		socketId: 'socket-b',
		userId: 'user-1',
		pseudo: 'Alice',
		picture: null,
	});

	const snapshot = await getRedisPresenceSnapshot(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
	});

	assert.equal(snapshot.onlineCount, 1);
	assert.deepEqual(snapshot.users, [
		{ userId: 'user-1', pseudo: 'Alice', picture: null },
	]);
});

test('presence snapshot removes stale socket ids from the index', async () => {
	const redis = new FakeRedis();
	const indexKey = buildPresenceSocketIndexKey('org-1', 'survey-1');
	await redis.sadd(indexKey, 'stale-socket');

	const snapshot = await getRedisPresenceSnapshot(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
	});

	assert.equal(snapshot.onlineCount, 0);
	assert.deepEqual(await redis.smembers(indexKey), []);
});

test('removeSocketPresence removes the socket and preserves other users', async () => {
	const redis = new FakeRedis();
	await touchSocketPresence(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
		socketId: 'socket-a',
		userId: 'user-1',
		pseudo: 'Alice',
		picture: null,
	});
	await touchSocketPresence(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
		socketId: 'socket-b',
		userId: 'user-2',
		pseudo: 'Bob',
		picture: null,
	});

	await removeSocketPresence(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		socketId: 'socket-a',
	});

	const snapshot = await getRedisPresenceSnapshot(redis, {
		organizationId: 'org-1',
		surveyId: 'survey-1',
		roomName: 'survey-survey-1',
	});

	assert.equal(snapshot.onlineCount, 1);
	assert.deepEqual(snapshot.users, [
		{ userId: 'user-2', pseudo: 'Bob', picture: null },
	]);
});
