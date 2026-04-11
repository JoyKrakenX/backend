/** @format */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ContentModerationLog = require('../models/ContentModerationLog');
const {
	CONTENT_MODERATION_CONFIG,
	CONTENT_MODERATION_SURFACES,
	CONTENT_MODERATION_VERDICTS,
	normalizeModerationLocale,
	SUPPORTED_MODERATION_LOCALES,
} = require('../utils/contentModerationConfig');

let OpenAIClientCtor = null;
try {
	const openaiModule = require('openai');
	OpenAIClientCtor =
		openaiModule?.OpenAI || openaiModule?.default || openaiModule || null;
} catch (_error) {
	OpenAIClientCtor = null;
}

const WORDLIST_DIR = path.join(__dirname, '../data/moderation/ldnoobw');
const PROFANITY_CSV_PATH = path.join(__dirname, '../data/moderation/profanity.csv');
const OPENAI_UNAVAILABLE_REASON = 'OPENAI_PROVIDER_UNAVAILABLE';
const OPENAI_RATE_LIMIT_REASON = 'OPENAI_RATE_LIMITED';
const OPENAI_COOLDOWN_REASON = 'OPENAI_PROVIDER_COOLDOWN';
const EXACT_LEXICAL_REASON = 'LDNOOBW_EXACT_MATCH';
const PROFANITY_CSV_REASON = 'PROFANITY_CSV_MATCH';
const OBFUSCATION_MAP = Object.freeze({
	'@': 'a',
	'0': 'o',
	'1': 'i',
	'3': 'e',
	'4': 'a',
	'5': 's',
	'7': 't',
	'$': 's',
	'+': 't',
	'!': 'i',
});
const OPENAI_CATEGORY_REASON_MAP = Object.freeze({
	harassment: 'OPENAI_HARASSMENT',
	'harassment/threatening': 'OPENAI_HARASSMENT_THREATENING',
	hate: 'OPENAI_HATE',
	'hate/threatening': 'OPENAI_HATE_THREATENING',
	illicit: 'OPENAI_ILLICIT',
	'illicit/violent': 'OPENAI_ILLICIT_VIOLENT',
	sexual: 'OPENAI_SEXUAL',
	'sexual/minors': 'OPENAI_SEXUAL_MINORS',
	violence: 'OPENAI_VIOLENCE',
	'violence/graphic': 'OPENAI_VIOLENCE_GRAPHIC',
	'self-harm': 'OPENAI_SELF_HARM',
	'self-harm/intent': 'OPENAI_SELF_HARM_INTENT',
	'self-harm/instructions': 'OPENAI_SELF_HARM_INSTRUCTIONS',
});

const wordlistCache = new Map();
const profanityCsvCache = new Map();
const moderationCache = new Map();
let openAiClient = null;
let openAiProviderCooldownUntil = 0;
let openAiProviderLastFailure = null;
let moderationWarmupPromise = null;

const removeDiacritics = (value) =>
	String(value || '')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');

const normalizeForLexicalMatch = (value) => {
	const nfkc = String(value || '').normalize('NFKC').toLowerCase();
	const deobfuscated = Array.from(nfkc)
		.map((character) => OBFUSCATION_MAP[character] || character)
		.join('');
	return removeDiacritics(deobfuscated)
		.replace(/[\u2019']/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

const normalizeForHash = (value) =>
	String(value || '')
		.normalize('NFKC')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();

const buildTextHash = (normalizedText) =>
	crypto.createHash('sha256').update(String(normalizedText || '')).digest('hex');

const buildTextPreview = (text) => {
	const safeText = String(text || '').trim();
	if (!safeText) return '';
	return safeText.slice(0, CONTENT_MODERATION_CONFIG.maxPreviewLength);
};

const getEnabledForSurface = (surface) => {
	if (!CONTENT_MODERATION_CONFIG.enabled) return false;
	if (surface === CONTENT_MODERATION_SURFACES.CHAT) {
		return CONTENT_MODERATION_CONFIG.chatEnabled;
	}
	if (surface === CONTENT_MODERATION_SURFACES.SURVEY_COMMENT) {
		return CONTENT_MODERATION_CONFIG.surveyCommentsEnabled;
	}
	return false;
};

const loadWordlistForLocale = (locale) => {
	const normalizedLocale = normalizeModerationLocale(locale);
	if (wordlistCache.has(normalizedLocale)) {
		return wordlistCache.get(normalizedLocale);
	}

	const filePath = path.join(WORDLIST_DIR, `${normalizedLocale}.txt`);
	let rawEntries = [];
	try {
		rawEntries = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
	} catch (_error) {
		rawEntries = [];
	}

	const entries = rawEntries
		.map((entry) => normalizeForLexicalMatch(entry))
		.filter((entry) => entry.length >= 2);
	const uniqueEntries = Array.from(new Set(entries));
	const wordlist = {
		locale: normalizedLocale,
		terms: uniqueEntries,
		termSet: new Set(uniqueEntries),
	};
	wordlistCache.set(normalizedLocale, wordlist);
	return wordlist;
};

const buildEmptyWordlist = (locale) => ({
	locale,
	terms: [],
	termSet: new Set(),
	termMeta: new Map(),
});

const loadProfanityCsvWordlists = () => {
	if (profanityCsvCache.size > 0) {
		return profanityCsvCache;
	}

	const index = new Map(
		SUPPORTED_MODERATION_LOCALES.map((locale) => [locale, buildEmptyWordlist(locale)]),
	);

	let rawCsv = '';
	try {
		rawCsv = fs.readFileSync(PROFANITY_CSV_PATH, 'utf8');
	} catch (_error) {
		rawCsv = '';
	}

	rawCsv
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith('#'))
		.slice(1)
		.forEach((line) => {
			const [rawLocale = '', rawTerm = '', rawSeverity = 'medium'] = line
				.split(',')
				.map((entry) => String(entry || '').trim());
			const locale = normalizeModerationLocale(rawLocale);
			const term = normalizeForLexicalMatch(rawTerm);
			if (!term || term.length < 2) return;

			const wordlist = index.get(locale) || buildEmptyWordlist(locale);
			if (!wordlist.termSet.has(term)) {
				wordlist.terms.push(term);
				wordlist.termSet.add(term);
			}
			wordlist.termMeta.set(term, {
				source: 'profanity_csv',
				severity: rawSeverity || 'medium',
			});
			index.set(locale, wordlist);
		});

	for (const [locale, wordlist] of index.entries()) {
		wordlist.terms.sort((left, right) => left.localeCompare(right));
		profanityCsvCache.set(locale, wordlist);
	}

	return profanityCsvCache;
};

const loadProfanityCsvWordlistForLocale = (locale) => {
	const normalizedLocale = normalizeModerationLocale(locale);
	const index = loadProfanityCsvWordlists();
	return index.get(normalizedLocale) || buildEmptyWordlist(normalizedLocale);
};

const getCandidateLocales = (locale) => {
	const normalizedLocale = normalizeModerationLocale(locale);
	return Array.from(new Set([normalizedLocale, ...SUPPORTED_MODERATION_LOCALES]));
};

const collectLexicalMatches = ({ text, locale }) => {
	const normalizedText = normalizeForLexicalMatch(text);
	if (!normalizedText) {
		return {
			normalizedText,
			matches: [],
		};
	}

	const paddedText = ` ${normalizedText} `;
	const matches = [];

	getCandidateLocales(locale).forEach((candidateLocale) => {
		const wordlists = [
			{
				source: 'ldnoobw',
				wordlist: loadWordlistForLocale(candidateLocale),
			},
			{
				source: 'profanity_csv',
				wordlist: loadProfanityCsvWordlistForLocale(candidateLocale),
			},
		];

		wordlists.forEach(({ source, wordlist }) => {
			wordlist.terms.forEach((term) => {
				const needle = ` ${term} `;
				if (paddedText.includes(needle)) {
					const meta = wordlist.termMeta?.get(term) || {};
					matches.push({
						locale: candidateLocale,
						term,
						source,
						severity: meta.severity || 'medium',
					});
				}
			});
		});
	});

	const deduped = Array.from(
		new Map(
			matches.map((match) => [
				`${match.locale}:${match.source}:${match.term}`,
				match,
			]),
		).values(),
	).sort((left, right) => left.term.localeCompare(right.term));

	return {
		normalizedText,
		matches: deduped,
	};
};

const getOpenAiClient = () => {
	if (openAiClient) return openAiClient;
	const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
	if (!apiKey || !OpenAIClientCtor) return null;
	openAiClient = new OpenAIClientCtor({
		apiKey,
		maxRetries: 0,
		timeout: CONTENT_MODERATION_CONFIG.openAiTimeoutMs,
	});
	return openAiClient;
};

const buildUnavailableOpenAiSummary = ({
	locale,
	error,
	status = null,
	reasonCodes = [OPENAI_UNAVAILABLE_REASON],
	providerMeta = {},
}) => ({
	flagged: false,
	providerStatus: 'unavailable',
	reasonCodes,
	categories: {},
	categoryScores: {},
	providerMeta: {
		error: error || 'OPENAI_PROVIDER_FAILURE',
		locale,
		status,
		...providerMeta,
	},
});

const buildSkippedOpenAiSummary = (providerMeta = {}) => ({
	flagged: false,
	providerStatus: 'skipped',
	reasonCodes: [],
	categories: {},
	categoryScores: {},
	providerMeta: {
		skipped: true,
		...providerMeta,
	},
});

const markOpenAiProviderUnavailable = ({
	reason,
	status = null,
	error = null,
}) => {
	openAiProviderCooldownUntil =
		Date.now() + CONTENT_MODERATION_CONFIG.openAiCooldownMs;
	openAiProviderLastFailure = {
		reason: reason || OPENAI_UNAVAILABLE_REASON,
		status,
		error: error || 'OPENAI_PROVIDER_FAILURE',
		recordedAt: new Date().toISOString(),
	};
};

const clearOpenAiProviderUnavailable = () => {
	openAiProviderCooldownUntil = 0;
	openAiProviderLastFailure = null;
};

const summarizeOpenAiModeration = (rawResult) => {
	const result = rawResult?.results?.[0];
	if (!result) {
		return {
			flagged: false,
			providerStatus: 'unavailable',
			reasonCodes: [OPENAI_UNAVAILABLE_REASON],
			categories: {},
			categoryScores: {},
			providerMeta: {
				error: 'OPENAI_EMPTY_RESULT',
			},
		};
	}

	const categories = result.categories || {};
	const categoryScores = result.category_scores || {};
	const flaggedCategories = Object.entries(categories)
		.filter(([, value]) => Boolean(value))
		.map(([category]) => category);

	return {
		flagged: Boolean(result.flagged || flaggedCategories.length),
		providerStatus: 'available',
		reasonCodes: flaggedCategories.map(
			(category) => OPENAI_CATEGORY_REASON_MAP[category] || `OPENAI_${category}`,
		),
		categories,
		categoryScores,
		providerMeta: {
			flagged: Boolean(result.flagged || flaggedCategories.length),
			flaggedCategories,
			categoryScores,
			categoryAppliedInputTypes: result.category_applied_input_types || null,
		},
	};
};

const runOpenAiModeration = async ({ text, locale, skipProvider = false }) => {
	if (skipProvider) {
		return buildSkippedOpenAiSummary({
			locale,
			skipReason: 'LEXICAL_FAST_BLOCK',
		});
	}

	const client = getOpenAiClient();
	if (!client) {
		return buildUnavailableOpenAiSummary({
			locale,
			error: 'OPENAI_API_KEY_MISSING',
		});
	}

	if (openAiProviderCooldownUntil > Date.now()) {
		return buildUnavailableOpenAiSummary({
			locale,
			error: openAiProviderLastFailure?.error || 'OPENAI_PROVIDER_COOLDOWN',
			status: openAiProviderLastFailure?.status || null,
			reasonCodes: [OPENAI_UNAVAILABLE_REASON, OPENAI_COOLDOWN_REASON],
			providerMeta: {
				cooldownUntil: new Date(openAiProviderCooldownUntil).toISOString(),
				lastFailure: openAiProviderLastFailure,
			},
		});
	}

	const startedAt = Date.now();
	try {
		const response = await client.moderations.create({
			model: CONTENT_MODERATION_CONFIG.openAiModel,
			input: text,
		});
		const summary = summarizeOpenAiModeration(response);
		clearOpenAiProviderUnavailable();
		summary.providerMeta = {
			...(summary.providerMeta || {}),
			responseTimeMs: Date.now() - startedAt,
		};
		return summary;
	} catch (error) {
		const status = Number(error?.status || 0) || null;
		const reasonCodes =
			status === 429 ?
				[OPENAI_UNAVAILABLE_REASON, OPENAI_RATE_LIMIT_REASON]
			:	[OPENAI_UNAVAILABLE_REASON];
		markOpenAiProviderUnavailable({
			reason: reasonCodes[reasonCodes.length - 1],
			status,
			error: error?.message || 'OPENAI_PROVIDER_FAILURE',
		});
		return buildUnavailableOpenAiSummary({
			locale,
			error: error?.message || 'OPENAI_PROVIDER_FAILURE',
			status,
			reasonCodes,
			providerMeta: {
				responseTimeMs: Date.now() - startedAt,
			},
		});
	}
};

const buildVerdictForSurface = (surface, shouldBlock) => {
	if (!shouldBlock) return CONTENT_MODERATION_VERDICTS.ALLOW;
	return surface === CONTENT_MODERATION_SURFACES.CHAT ?
			CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT
		:	CONTENT_MODERATION_VERDICTS.AUTO_HIDE_COMMENT;
};

const buildDecisionSource = ({ lexicalMatches, openAiSummary }) => {
	const lexicalSources = new Set(
		(lexicalMatches || []).map((match) => String(match?.source || 'ldnoobw')),
	);
	if ((lexicalMatches || []).length && openAiSummary.flagged) return 'hybrid';
	if (lexicalSources.size > 1) return 'hybrid';
	if (lexicalSources.has('profanity_csv')) {
		return 'profanity_csv';
	}
	if (lexicalSources.has('ldnoobw')) {
		return 'ldnoobw';
	}
	if (openAiSummary.flagged) return 'openai';
	return openAiSummary.providerStatus === 'unavailable' ? 'fallback' : 'openai';
};

const getCacheEntry = (cacheKey) => {
	const existing = moderationCache.get(cacheKey);
	if (!existing) return null;
	if (existing.expiresAt <= Date.now()) {
		moderationCache.delete(cacheKey);
		return null;
	}
	return existing.value;
};

const setCacheEntry = (cacheKey, value) => {
	moderationCache.set(cacheKey, {
		value,
		expiresAt: Date.now() + CONTENT_MODERATION_CONFIG.cacheTtlMs,
	});
};

const evaluateContentModeration = async ({
	text,
	surface,
	locale,
}) => {
	const startedAt = process.hrtime.bigint();
	const normalizedLocale = normalizeModerationLocale(locale);
	const normalizedHashSource = normalizeForHash(text);
	const textHash = buildTextHash(normalizedHashSource);
	const cacheKey = `${surface}:${normalizedLocale}:${textHash}`;
	const cached = getCacheEntry(cacheKey);
	if (cached) {
		return {
			...cached,
			timings: {
				...(cached.timings || {}),
				cacheHit: true,
			},
		};
	}

	const lexicalStartedAt = process.hrtime.bigint();
	const lexical = collectLexicalMatches({
		text,
		locale: normalizedLocale,
	});
	const lexicalMs =
		Number(process.hrtime.bigint() - lexicalStartedAt) / 1e6;
	const lexicalFlagged = lexical.matches.length > 0;

	const providerStartedAt = process.hrtime.bigint();
	const openAiSummary = await runOpenAiModeration({
		text,
		locale: normalizedLocale,
		skipProvider: lexicalFlagged,
	});
	const providerMs =
		Number(process.hrtime.bigint() - providerStartedAt) / 1e6;
	const shouldBlock = lexicalFlagged || openAiSummary.flagged;
	const recommendedVerdict = buildVerdictForSurface(surface, shouldBlock);
	const enforced =
		CONTENT_MODERATION_CONFIG.mode === 'enforce' && recommendedVerdict !== 'allow';
	const appliedVerdict =
		enforced ? recommendedVerdict : CONTENT_MODERATION_VERDICTS.ALLOW;
	const reasonCodes = Array.from(
		new Set([
			...(lexical.matches.some((match) => match.source === 'ldnoobw') ?
				[EXACT_LEXICAL_REASON]
			:	[]),
			...(lexical.matches.some((match) => match.source === 'profanity_csv') ?
				[PROFANITY_CSV_REASON]
			:	[]),
			...openAiSummary.reasonCodes,
		]),
	);
	const providerStatus =
		openAiSummary.providerStatus === 'available' ? 'available' : 'unavailable';

	const decision = {
		surface,
		locale: normalizedLocale,
		textHash,
		textPreview: buildTextPreview(text),
		textLength: String(text || '').trim().length,
		normalizedText: lexical.normalizedText,
		recommendedVerdict,
		appliedVerdict,
		enforced,
		source: buildDecisionSource({
			lexicalMatches: lexical.matches,
			openAiSummary,
		}),
		reasonCodes,
		lexicalMatches: lexical.matches,
		providerStatus:
			openAiSummary.providerStatus === 'skipped' ? 'skipped' : providerStatus,
		providerMeta: openAiSummary.providerMeta,
		openAi: openAiSummary,
		timings: {
			cacheHit: false,
			lexicalMs: Number(lexicalMs.toFixed(2)),
			providerMs: Number(providerMs.toFixed(2)),
			totalMs: Number(
				(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(2),
			),
		},
	};

	setCacheEntry(cacheKey, decision);
	return decision;
};

const createContentModerationLog = async ({
	surface,
	surveyId = null,
	surveyType = 'unknown',
	surveyModel = null,
	userId = null,
	userPseudoSnapshot = null,
	decision,
}) => {
	if (!decision) return null;

	return ContentModerationLog.create({
		surface,
		surveyId,
		surveyType,
		surveyModel,
		userId,
		userPseudoSnapshot:
			String(userPseudoSnapshot || '').trim() || null,
		locale: decision.locale,
		textHash: decision.textHash,
		textPreview: decision.textPreview,
		textLength: decision.textLength,
		verdict: decision.recommendedVerdict,
		enforced: decision.enforced,
		mode: CONTENT_MODERATION_CONFIG.mode,
		source: decision.source,
		reasonCodes: decision.reasonCodes,
		providerStatus: decision.providerStatus,
		providerMeta: decision.providerMeta,
		lexicalMatches: decision.lexicalMatches,
	});
};

const shouldPersistModerationLog = (decision) => {
	if (!decision) return false;
	if (decision.recommendedVerdict !== CONTENT_MODERATION_VERDICTS.ALLOW) {
		return true;
	}
	return CONTENT_MODERATION_CONFIG.logAllowDecisions;
};

const moderateContent = async ({
	surface,
	text,
	locale,
	surveyId = null,
	surveyType = 'unknown',
	surveyModel = null,
	userId = null,
	userPseudoSnapshot = null,
}) => {
	const enabled = getEnabledForSurface(surface);
	const normalizedLocale = normalizeModerationLocale(locale);
	if (!enabled) {
		return {
			ok: true,
			decision: {
				surface,
				locale: normalizedLocale,
				textHash: buildTextHash(normalizeForHash(text)),
				textPreview: buildTextPreview(text),
				textLength: String(text || '').trim().length,
				recommendedVerdict: CONTENT_MODERATION_VERDICTS.ALLOW,
				appliedVerdict: CONTENT_MODERATION_VERDICTS.ALLOW,
				enforced: false,
				source: 'fallback',
				reasonCodes: [],
				lexicalMatches: [],
				providerStatus: 'skipped',
				providerMeta: { skipped: true, featureEnabled: false },
			},
			logEntry: null,
		};
	}

	const decision = await evaluateContentModeration({
		text,
		surface,
		locale: normalizedLocale,
	});
	const logEntry =
		shouldPersistModerationLog(decision) ?
			await createContentModerationLog({
				surface,
				surveyId,
				surveyType,
				surveyModel,
				userId,
				userPseudoSnapshot,
				decision,
			})
		:	null;
	return {
		ok: decision.appliedVerdict === CONTENT_MODERATION_VERDICTS.ALLOW,
		decision,
		logEntry,
	};
};

const moderateChatMessage = async (payload = {}) =>
	moderateContent({
		...payload,
		surface: CONTENT_MODERATION_SURFACES.CHAT,
	});

const moderateSurveyComment = async (payload = {}) =>
	moderateContent({
		...payload,
		surface: CONTENT_MODERATION_SURFACES.SURVEY_COMMENT,
	});

const primeContentModeration = async () => {
	if (moderationWarmupPromise) {
		return moderationWarmupPromise;
	}

	moderationWarmupPromise = (async () => {
		const lexicalLocales = [];
		for (const locale of SUPPORTED_MODERATION_LOCALES) {
			loadWordlistForLocale(locale);
			loadProfanityCsvWordlistForLocale(locale);
			lexicalLocales.push(locale);
		}

		let provider = 'skipped';
		let providerStatus = 'skipped';
		if (getOpenAiClient()) {
			const summary = await runOpenAiModeration({
				text: 'Community moderation warmup',
				locale: 'en',
			});
			provider = 'primed';
			providerStatus = summary.providerStatus;
		}

		return {
			lexicalLocales,
			provider,
			providerStatus,
		};
	})();

	return moderationWarmupPromise;
};

const resetModerationTestState = () => {
	wordlistCache.clear();
	profanityCsvCache.clear();
	moderationCache.clear();
	openAiClient = null;
	openAiProviderCooldownUntil = 0;
	openAiProviderLastFailure = null;
	moderationWarmupPromise = null;
};

const setOpenAiClientCtorForTests = (ctor) => {
	OpenAIClientCtor = ctor || null;
	openAiClient = null;
};

module.exports = {
	OPENAI_UNAVAILABLE_REASON,
	EXACT_LEXICAL_REASON,
	PROFANITY_CSV_REASON,
	OPENAI_COOLDOWN_REASON,
	OPENAI_RATE_LIMIT_REASON,
	moderateContent,
	moderateChatMessage,
	moderateSurveyComment,
	primeContentModeration,
	loadWordlistForLocale,
	loadProfanityCsvWordlistForLocale,
	createContentModerationLog,
	__test__: {
		removeDiacritics,
		normalizeForLexicalMatch,
		normalizeForHash,
		buildTextHash,
		buildTextPreview,
		collectLexicalMatches,
		buildVerdictForSurface,
		buildDecisionSource,
		evaluateContentModeration,
		wordlistCache,
		moderationCache,
		setCacheEntry,
		getCacheEntry,
		runOpenAiModeration,
		getEnabledForSurface,
		primeContentModeration,
		loadProfanityCsvWordlistForLocale,
		profanityCsvCache,
		resetModerationTestState,
		setOpenAiClientCtorForTests,
	},
};
