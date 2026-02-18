/** @format */

const DEFAULT_FALLBACK_ORIGIN = 'http://127.0.0.1:3000';

function safeParseUrl(raw) {
	if (!raw) return null;
	try {
		return new URL(String(raw).trim());
	} catch (_error) {
		return null;
	}
}

function normalizeFrontendBase(raw) {
	const parsed = safeParseUrl(raw);
	if (!parsed) return null;

	parsed.search = '';
	parsed.hash = '';

	// Historical values sometimes ended with /frontend while app is now served at root.
	if (
		parsed.pathname === '/frontend' ||
		parsed.pathname === '/frontend/' ||
		parsed.pathname === ''
	) {
		parsed.pathname = '/';
	}

	parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
	return parsed.toString().replace(/\/+$/, '');
}

function inferOriginFromRequest(req) {
	const forwardedProtoRaw = String(req?.headers?.['x-forwarded-proto'] || '')
		.split(',')
		.map((value) => value.trim())
		.find(Boolean);

	const forwardedHostRaw = String(req?.headers?.['x-forwarded-host'] || '')
		.split(',')
		.map((value) => value.trim())
		.find(Boolean);

	const hostRaw =
		forwardedHostRaw ||
		String(req?.headers?.host || '').trim() ||
		'127.0.0.1:3000';

	const protocol =
		forwardedProtoRaw ||
		(req?.secure ? 'https' : '') ||
		(hostRaw.includes('localhost') || hostRaw.startsWith('127.') ?
			'http'
		:	'https');

	return `${protocol}://${hostRaw}`;
}

function getFrontendBaseUrl(req) {
	const candidates = [
		process.env.FRONTEND_BASE_URL,
		process.env.FRONTEND_URL,
		process.env.APP_PUBLIC_URL,
		inferOriginFromRequest(req),
		DEFAULT_FALLBACK_ORIGIN,
	];

	for (const candidate of candidates) {
		const normalized = normalizeFrontendBase(candidate);
		if (normalized) return normalized;
	}

	return DEFAULT_FALLBACK_ORIGIN;
}

function buildFrontendUrl(req, pageName, query = {}) {
	const base = getFrontendBaseUrl(req);
	const url = new URL(base);

	url.pathname = `/${String(pageName || '').replace(/^\/+/, '')}`;
	url.search = '';
	url.hash = '';

	Object.entries(query || {}).forEach(([key, value]) => {
		if (value === null || value === undefined || value === '') return;
		url.searchParams.set(String(key), String(value));
	});

	return url.toString();
}

module.exports = {
	getFrontendBaseUrl,
	buildFrontendUrl,
};
