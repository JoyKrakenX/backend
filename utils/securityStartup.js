/** @format */

const REQUIRED_PROD_SECRETS = [
	'JWT_SECRET',
	'JWT_TEMP_SECRET',
	'MONGO_URI',
	'REDIS_URL',
	'GOOGLE_CLIENT_ID',
	'GOOGLE_CLIENT_SECRET',
	'FEDAPAY_SECRET_KEY',
	'FEDAPAY_WEBHOOK_SECRET',
	'OXR_APP_ID',
	'BILLING_SIGNING_SECRET',
];

const FRAUD_REQUIRED_PROD_SECRETS = [
	'TURNSTILE_SECRET_KEY',
	'IPQS_API_KEY',
	'FRAUD_IP_HASH_SECRET',
	'FRAUD_DEVICE_HASH_SECRET',
	'FRAUD_DEVICE_COOKIE_SECRET',
];

const parseBoolean = (value, fallback = false) => {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
};

const validateProductionSecrets = () => {
	if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
		return;
	}

	const missing = REQUIRED_PROD_SECRETS.filter((name) => {
		const value = String(process.env[name] || '').trim();
		return !value;
	});
	if (parseBoolean(process.env.FRAUD_ENGINE_ENABLED, true)) {
		const missingFraud = FRAUD_REQUIRED_PROD_SECRETS.filter((name) => {
			const value = String(process.env[name] || '').trim();
			return !value;
		});
		missing.push(...missingFraud);
	}

	if (!missing.length) {
		console.log('Security startup check: required production secrets are configured.');
		console.log('Security reminder: rotate JWT/OAuth/DB/Mail/VAPID/API secrets before go-live.');
		return;
	}

	console.error('Security startup check failed: missing required secrets.');
	console.error(`Missing: ${missing.join(', ')}`);
	console.error(
		'Rotate and configure secrets (JWT, OAuth, DB, Mail, VAPID, provider keys) before launch.',
	);
	throw new Error('Missing required production secrets.');
};

module.exports = {
	validateProductionSecrets,
};
