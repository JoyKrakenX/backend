/** @format */

const Decimal = require('decimal.js');
const { getRedisClient } = require('../redisService');

const OXR_BASE_URL = 'https://openexchangerates.org/api/latest.json';
const FX_CACHE_KEY = 'fx:oxr:latest';
const FX_CACHE_TTL_SECONDS = 60;
const FX_DEFAULT_MAX_STALE_MS = 5 * 60 * 1000;
const FX_DEFAULT_LOCK_MINUTES = 15;

const MINOR_UNITS = Object.freeze({
	USD: 2,
	EUR: 2,
	XOF: 0,
	GNF: 0,
});

const toDateOrNull = (value) => {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const getMinorUnitDigits = (currency) => {
	const normalized = String(currency || '').trim().toUpperCase();
	if (Object.prototype.hasOwnProperty.call(MINOR_UNITS, normalized)) {
		return MINOR_UNITS[normalized];
	}
	return 2;
};

const normalizeQuoteCurrency = (currency) => {
	const normalized = String(currency || '').trim().toUpperCase();
	if (normalized === 'GNF') return 'GNF';
	return 'XOF';
};

const getAppId = () => String(process.env.OXR_APP_ID || '').trim();

const isFxConfigured = () => Boolean(getAppId());

const parseCachedRates = (raw) => {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		if (!parsed.rates || typeof parsed.rates !== 'object') return null;
		const asOf = toDateOrNull(parsed.asOf || parsed.timestamp || parsed.fetchedAt);
		if (!asOf) return null;
		return {
			source: 'openexchangerates',
			baseCurrency: 'USD',
			asOf,
			rates: parsed.rates,
			fetchedAt: toDateOrNull(parsed.fetchedAt) || asOf,
		};
	} catch (_error) {
		return null;
	}
};

const storeCachedRates = async (snapshot) => {
	const redis = await getRedisClient();
	if (!redis || !snapshot) return;
	const payload = JSON.stringify({
		rates: snapshot.rates,
		asOf: snapshot.asOf,
		fetchedAt: snapshot.fetchedAt,
	});
	await redis.set(FX_CACHE_KEY, payload, 'EX', FX_CACHE_TTL_SECONDS);
};

const fetchLatestRates = async () => {
	if (!isFxConfigured()) {
		throw new Error('Open Exchange Rates non configuré (OXR_APP_ID manquant).');
	}

	const url = `${OXR_BASE_URL}?app_id=${encodeURIComponent(getAppId())}&base=USD`;
	const response = await fetch(url, { method: 'GET' });
	const body = await response.json().catch(() => ({}));
	if (!response.ok || !body?.rates || body?.base !== 'USD') {
		throw new Error(body?.description || body?.message || 'Impossible de recuperer les taux OXR.');
	}

	const asOf = toDateOrNull((Number(body.timestamp || 0) || Date.now() / 1000) * 1000) || new Date();
	const snapshot = {
		source: 'openexchangerates',
		baseCurrency: 'USD',
		asOf,
		rates: body.rates,
		fetchedAt: new Date(),
	};
	await storeCachedRates(snapshot);
	return snapshot;
};

const getLatestRates = async ({ maxStaleMs = FX_DEFAULT_MAX_STALE_MS } = {}) => {
	const redis = await getRedisClient();
	const cached = redis ? parseCachedRates(await redis.get(FX_CACHE_KEY)) : null;
	const now = Date.now();

	if (cached) {
		const ageMs = Math.max(0, now - cached.fetchedAt.getTime());
		if (ageMs <= FX_CACHE_TTL_SECONDS * 1000) {
			return { ...cached, stale: false };
		}
	}

	try {
		const fresh = await fetchLatestRates();
		return { ...fresh, stale: false };
	} catch (error) {
		if (cached) {
			const ageMs = Math.max(0, now - cached.fetchedAt.getTime());
			if (ageMs <= Number(maxStaleMs || FX_DEFAULT_MAX_STALE_MS)) {
				return { ...cached, stale: true };
			}
		}
		throw error;
	}
};

const quoteUsdAmount = ({ amountUsd, quoteCurrency, rate }) => {
	const safeAmountUsd = new Decimal(Number(amountUsd || 0));
	const safeRate = new Decimal(Number(rate || 0));
	if (safeAmountUsd.isNegative()) {
		throw new Error('Montant USD negatif non autorise.');
	}
	if (!safeRate.isFinite() || safeRate.lte(0)) {
		throw new Error('Taux FX invalide.');
	}

	const currency = normalizeQuoteCurrency(quoteCurrency);
	const digits = getMinorUnitDigits(currency);
	const chargeAmount = safeAmountUsd.mul(safeRate).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP);
	const minorFactor = new Decimal(10).pow(digits);
	const minorUnitAmount = chargeAmount.mul(minorFactor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

	return {
		currency,
		rate: Number(safeRate.toString()),
		amountUsd: Number(safeAmountUsd.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toString()),
		chargeAmount: Number(chargeAmount.toString()),
		minorUnitAmount: Number(minorUnitAmount.toString()),
	};
};

const createFxQuote = async ({ amountUsd, quoteCurrency }) => {
	const snapshot = await getLatestRates({ maxStaleMs: FX_DEFAULT_MAX_STALE_MS });
	const currency = normalizeQuoteCurrency(quoteCurrency);
	const rate = Number(snapshot?.rates?.[currency] || 0);
	if (!Number.isFinite(rate) || rate <= 0) {
		throw new Error(`Taux FX indisponible pour ${currency}.`);
	}

	const quoted = quoteUsdAmount({ amountUsd, quoteCurrency: currency, rate });
	return {
		...quoted,
		source: snapshot.source,
		asOf: snapshot.asOf,
		stale: Boolean(snapshot.stale),
	};
};

const buildFxLock = async ({
	amountUsd,
	quoteCurrency,
	lockMinutes = FX_DEFAULT_LOCK_MINUTES,
}) => {
	const quote = await createFxQuote({ amountUsd, quoteCurrency });
	const lockedAt = new Date();
	const lockExpiresAt = new Date(lockedAt.getTime() + Math.max(1, Number(lockMinutes || FX_DEFAULT_LOCK_MINUTES)) * 60 * 1000);
	return {
		baseCurrency: 'USD',
		quoteCurrency: quote.currency,
		rate: quote.rate,
		source: quote.source,
		asOf: quote.asOf,
		lockedAt,
		lockExpiresAt,
		amountUsd: quote.amountUsd,
		chargeAmount: quote.chargeAmount,
		minorUnitAmount: quote.minorUnitAmount,
	};
};

const isFxLockExpired = (invoiceLike = {}, now = new Date()) => {
	const expiresAt = toDateOrNull(invoiceLike?.fx?.lockExpiresAt);
	if (!expiresAt) return true;
	return expiresAt.getTime() <= now.getTime();
};

module.exports = {
	isFxConfigured,
	normalizeQuoteCurrency,
	getMinorUnitDigits,
	getLatestRates,
	createFxQuote,
	buildFxLock,
	isFxLockExpired,
	FX_DEFAULT_LOCK_MINUTES,
};
