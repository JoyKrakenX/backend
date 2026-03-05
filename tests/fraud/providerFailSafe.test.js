/** @format */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..', '..');

const resolveBackendModule = (relativePath) =>
	require.resolve(path.join(backendRoot, relativePath));

const withEnv = (overrides = {}) => {
	const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
	Object.entries(overrides).forEach(([key, value]) => {
		process.env[key] = String(value);
	});
	return () => {
		for (const [key, value] of previous.entries()) {
			if (typeof value === 'undefined') delete process.env[key];
			else process.env[key] = value;
		}
	};
};

const setMockModule = (relativePath, exportsValue) => {
	const modulePath = resolveBackendModule(relativePath);
	const previous = require.cache[modulePath];
	require.cache[modulePath] = {
		id: modulePath,
		filename: modulePath,
		loaded: true,
		exports: exportsValue,
	};
	return () => {
		if (previous) require.cache[modulePath] = previous;
		else delete require.cache[modulePath];
	};
};

test('verifyTurnstile marks timeout on provider failure', async () => {
	const restoreEnv = withEnv({
		FRAUD_TURNSTILE_ENABLED: 'true',
		TURNSTILE_SECRET_KEY: 'turnstile-secret-test',
		TURNSTILE_TIMEOUT_MS: '300',
	});
	const originalFetch = global.fetch;
	global.fetch = async () => {
		throw new Error('provider timeout');
	};

	try {
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
		delete require.cache[resolveBackendModule('services/fraud/turnstileService.js')];
		const { verifyTurnstile } = require(path.join(
			backendRoot,
			'services/fraud/turnstileService.js',
		));

		const result = await verifyTurnstile({
			token: 'dummy-token',
			remoteIp: '198.51.100.20',
		});

		assert.equal(result.ok, false);
		assert.equal(result.timeout, true);
		assert.equal(result.code, 'TURNSTILE_TIMEOUT');
	} finally {
		restoreEnv();
		global.fetch = originalFetch;
		delete require.cache[resolveBackendModule('services/fraud/turnstileService.js')];
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
	}
});

test('ip reputation opens circuit breaker after repeated failures', async () => {
	const restoreEnv = withEnv({
		FRAUD_IPQS_ENABLED: 'true',
		IPQS_API_KEY: 'ipqs-test-key',
		IPQS_TIMEOUT_MS: '300',
		IPQS_CIRCUIT_FAIL_THRESHOLD: '2',
		IPQS_CIRCUIT_COOLDOWN_MS: '60000',
	});
	const originalFetch = global.fetch;
	let fetchCalls = 0;
	global.fetch = async () => {
		fetchCalls += 1;
		throw new Error('ipqs timeout');
	};

	const cleanups = [];
	try {
		cleanups.push(
			setMockModule('services/redisService.js', {
				getRedisClient: async () => null,
			}),
		);
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
		delete require.cache[resolveBackendModule('services/fraud/ipReputationService.js')];
		const { getIpReputation } = require(path.join(
			backendRoot,
			'services/fraud/ipReputationService.js',
		));

		const first = await getIpReputation({
			ip: '203.0.113.21',
			ipHash: 'iphash-1',
		});
		const second = await getIpReputation({
			ip: '203.0.113.21',
			ipHash: 'iphash-1',
		});
		const third = await getIpReputation({
			ip: '203.0.113.21',
			ipHash: 'iphash-1',
		});

		assert.equal(first.timedOut, true);
		assert.equal(second.timedOut, true);
		assert.equal(third.timedOut, true);
		assert.equal(Boolean(third.circuitOpen), true);
		assert.equal(fetchCalls, 2);
	} finally {
		for (const restore of cleanups.reverse()) {
			try {
				restore();
			} catch (_error) {}
		}
		restoreEnv();
		global.fetch = originalFetch;
		delete require.cache[resolveBackendModule('services/fraud/ipReputationService.js')];
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
	}
});

test('ip reputation does not quarantine by default when API key is missing', async () => {
	const restoreEnv = withEnv({
		FRAUD_IPQS_ENABLED: 'true',
		IPQS_API_KEY: '',
	});
	const originalFetch = global.fetch;
	let fetchCalls = 0;
	global.fetch = async () => {
		fetchCalls += 1;
		return {
			ok: true,
			json: async () => ({}),
		};
	};

	const cleanups = [];
	try {
		cleanups.push(
			setMockModule('services/redisService.js', {
				getRedisClient: async () => null,
			}),
		);
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
		delete require.cache[resolveBackendModule('services/fraud/ipReputationService.js')];
		const { getIpReputation } = require(path.join(
			backendRoot,
			'services/fraud/ipReputationService.js',
		));

		const result = await getIpReputation({
			ip: '203.0.113.51',
			ipHash: 'iphash-missing-key',
		});

		assert.equal(result.provider, 'none');
		assert.equal(result.timedOut, false);
		assert.equal(Boolean(result.misconfigured), true);
		assert.equal(fetchCalls, 0);
	} finally {
		for (const restore of cleanups.reverse()) {
			try {
				restore();
			} catch (_error) {}
		}
		restoreEnv();
		global.fetch = originalFetch;
		delete require.cache[resolveBackendModule('services/fraud/ipReputationService.js')];
		delete require.cache[resolveBackendModule('utils/fraudConfig.js')];
	}
});
