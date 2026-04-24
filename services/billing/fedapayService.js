/** @format */

const crypto = require('crypto');

const FEDAPAY_BASE_URL = String(process.env.FEDAPAY_BASE_URL || 'https://api.fedapay.com/v1').replace(/\/+$/, '');
const FEDAPAY_CHECKOUT_BASE_URL = String(
	process.env.FEDAPAY_CHECKOUT_BASE_URL || 'https://pay.fedapay.com/checkout',
).replace(/\/+$/, '');

const getSecretKey = () => String(process.env.FEDAPAY_SECRET_KEY || '').trim();
const getWebhookSecret = () =>
	String(process.env.FEDAPAY_WEBHOOK_SECRET || process.env.FEDAPAY_SIGNATURE_SECRET || '').trim();

const isConfigured = () => Boolean(getSecretKey());

const buildHeaders = () => ({
	Authorization: `Bearer ${getSecretKey()}`,
	'Content-Type': 'application/json',
	Accept: 'application/json',
});

const toRawBodyString = (req) =>
	typeof req?.rawBody === 'string' ?
		req.rawBody
	: Buffer.isBuffer(req?.rawBody) ?
		req.rawBody.toString('utf8')
	: JSON.stringify(req?.body || {});

const timingSafeEqualHex = (leftValue, rightValue) => {
	const left = Buffer.from(String(leftValue || ''), 'utf8');
	const right = Buffer.from(String(rightValue || ''), 'utf8');
	if (!left.length || left.length !== right.length) return false;
	return crypto.timingSafeEqual(left, right);
};

const parseFedaPaySignatureHeader = (headerValue) => {
	if (typeof headerValue !== 'string') return null;
	const parsed = headerValue.split(',').reduce(
		(acc, part) => {
			const [key, value] = String(part).split('=');
			const normalizedKey = String(key || '').trim().toLowerCase();
			const normalizedValue = String(value || '').trim();
			if (normalizedKey === 't') {
				acc.timestamp = Number(normalizedValue || 0);
			}
			if (normalizedKey === 's' && normalizedValue) {
				acc.signatures.push(normalizedValue);
			}
			return acc;
		},
		{ timestamp: 0, signatures: [] },
	);

	if (!parsed.timestamp || !parsed.signatures.length) return null;
	return parsed;
};

const parseBody = async (response) => response.json().catch(() => ({}));

const buildProviderErrorMessage = (parsed = {}, fallback = null) => {
	const base =
		parsed?.message || parsed?.error?.message || parsed?.error || fallback || 'FedaPay API error';
	const errors = parsed?.errors;
	if (!errors || typeof errors !== 'object') {
		return String(base);
	}

	const details = Object.entries(errors)
		.map(([field, value]) => {
			if (Array.isArray(value)) {
				return `${field}: ${value.join(', ')}`;
			}
			if (value && typeof value === 'object') {
				return `${field}: ${JSON.stringify(value)}`;
			}
			return `${field}: ${String(value)}`;
		})
		.filter(Boolean);

	if (!details.length) {
		return String(base);
	}

	return `${String(base)} (${details.join(' | ')})`;
};

const requestJson = async ({ method, path, body }) => {
	if (!isConfigured()) {
		throw new Error('FedaPay non configuré.');
	}

	const response = await fetch(`${FEDAPAY_BASE_URL}${path}`, {
		method,
		headers: buildHeaders(),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const parsed = await parseBody(response);
	if (!response.ok) {
		const message = buildProviderErrorMessage(parsed, `FedaPay API error (${response.status})`);
		const error = new Error(String(message));
		error.status = response.status;
		error.payload = parsed;
		throw error;
	}
	return parsed;
};

const getResponseData = (payload) => {
	if (!payload) return null;
	if (payload.data) return payload.data;
	if (payload.transaction) return payload.transaction;
	if (payload['v1/transaction']) return payload['v1/transaction'];
	if (payload['v1/token']) return payload['v1/token'];
	const versionedResourceEntry = Object.entries(payload).find(
		([key, value]) =>
			/^v\d+\/[a-z0-9_]+$/i.test(String(key)) &&
			value &&
			typeof value === 'object' &&
			!Array.isArray(value),
	);
	if (versionedResourceEntry) return versionedResourceEntry[1];
	return payload;
};

const normalizeCustomer = ({ customerEmail, customerName }) => {
	const safeEmail = String(customerEmail || '').trim();
	const fullName = String(customerName || '').trim();
	const parts = fullName.split(/\s+/).filter(Boolean);
	return {
		email: safeEmail || undefined,
		firstname: parts[0] || 'Community',
		lastname: parts.slice(1).join(' ') || 'Client',
	};
};

const createTransaction = async ({
	chargeAmount,
	chargeCurrency,
	description,
	callbackUrl,
	merchantReference,
	customerEmail,
	customerName,
	metadata = {},
}) => {
	const customer = normalizeCustomer({ customerEmail, customerName });
	const payload = {
		description,
		amount: Number(chargeAmount || 0),
		currency: { iso: String(chargeCurrency || 'XOF').toUpperCase() },
		callback_url: callbackUrl,
		reference: merchantReference,
		customer,
		include: 'customer,currency',
		metadata,
		custom_metadata: metadata,
	};

	try {
		const created = await requestJson({ method: 'POST', path: '/transactions', body: payload });
		return getResponseData(created);
	} catch (firstError) {
		// Some API variants historically expected nested payload in { transaction: {...} }.
		// Keep a guarded fallback, but preserve the original provider error when fallback also fails.
		const status = Number(firstError?.status || 0);
		const message = String(firstError?.message || '').toLowerCase();
		const shouldTryFallback =
			status >= 400 &&
			status < 500 &&
			(/parametre manquant|missing parameter|invalid request/i.test(message) ||
				message.includes('transaction'));

		if (!shouldTryFallback) {
			throw firstError;
		}

		try {
			const fallback = await requestJson({
				method: 'POST',
				path: '/transactions',
				body: { transaction: payload },
			});
			return getResponseData(fallback);
		} catch (_fallbackError) {
			throw firstError;
		}
	}
};

const buildCheckoutLink = ({ token, transactionId }) => {
	const normalizedToken = String(token || '').trim();
	if (normalizedToken) {
		return `${FEDAPAY_CHECKOUT_BASE_URL}/${encodeURIComponent(normalizedToken)}`;
	}
	if (transactionId) {
		return `${FEDAPAY_CHECKOUT_BASE_URL}?transaction_id=${encodeURIComponent(String(transactionId))}`;
	}
	return null;
};

const generateCheckoutToken = async ({ transactionId }) => {
	if (!transactionId) {
		throw new Error('transactionId manquant pour generation du token checkout.');
	}

	const response = await requestJson({
		method: 'POST',
		path: `/transactions/${encodeURIComponent(String(transactionId))}/token`,
		body: {},
	});

	const data = getResponseData(response) || {};
	const token =
		String(data?.token?.token || data?.token || data?.checkout_token || '').trim() || null;
	const url =
		String(data?.token?.url || data?.url || data?.checkout_url || '').trim() || null;
	return {
		token,
		url: url || buildCheckoutLink({ token, transactionId }),
	};
};

const retrieveTransaction = async (transactionId) => {
	if (!transactionId) {
		throw new Error('transactionId manquant pour verification FedaPay.');
	}
	const response = await requestJson({
		method: 'GET',
		path: `/transactions/${encodeURIComponent(String(transactionId))}`,
	});
	return getResponseData(response) || null;
};

const verifyWebhookSignature = (req) => {
	const secret = getWebhookSecret();
	if (!secret) return false;

	const incoming = String(
		req.headers['x-fedapay-signature'] ||
			req.headers['x-fp-signature'] ||
			req.headers['fedapay-signature'] ||
			req.headers['x-signature'] ||
			req.headers['x-webhook-signature'] ||
			'',
	).trim();
	if (!incoming) return false;

	const rawBody = toRawBodyString(req);

	// Official FedaPay format: "t=<timestamp>,s=<signature>".
	const parsed = parseFedaPaySignatureHeader(incoming);
	if (parsed) {
		const expected = crypto
			.createHmac('sha256', secret)
			.update(`${parsed.timestamp}.${rawBody}`, 'utf8')
			.digest('hex')
			.toLowerCase();

		const signatureOk = parsed.signatures.some((candidate) =>
			timingSafeEqualHex(String(candidate).toLowerCase(), expected),
		);
		if (!signatureOk) return false;

		const toleranceSeconds = Math.max(
			0,
			Number(process.env.FEDAPAY_WEBHOOK_TOLERANCE_SECONDS || 300),
		);
		if (toleranceSeconds > 0) {
			const ageSeconds = Math.floor(Date.now() / 1000) - Number(parsed.timestamp || 0);
			if (ageSeconds > toleranceSeconds) return false;
		}
		return true;
	}

	// Legacy fallback for custom simple signatures.
	const expectedLegacy = crypto
		.createHmac('sha256', secret)
		.update(rawBody, 'utf8')
		.digest('hex')
		.toLowerCase();
	const incomingLegacy = incoming.replace(/^sha256=/i, '').toLowerCase();
	return timingSafeEqualHex(incomingLegacy, expectedLegacy);
};

module.exports = {
	isConfigured,
	createTransaction,
	generateCheckoutToken,
	retrieveTransaction,
	verifyWebhookSignature,
};
