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
const OPENAI_UNAVAILABLE_REASON = 'OPENAI_PROVIDER_UNAVAILABLE';
const EXACT_LEXICAL_REASON = 'LDNOOBW_EXACT_MATCH';
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
const moderationCache = new Map();
let openAiClient = null;

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
		const wordlist = loadWordlistForLocale(candidateLocale);
		wordlist.terms.forEach((term) => {
			const needle = ` ${term} `;
			if (paddedText.includes(needle)) {
				matches.push({
					locale: candidateLocale,
					term,
				});
			}
		});
	});

	const deduped = Array.from(
		new Map(
			matches.map((match) => [`${match.locale}:${match.term}`, match]),
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
	openAiClient = new OpenAIClientCtor({ apiKey });
	return openAiClient;
};

const withTimeout = async (promise, timeoutMs) => {
	let timeoutId = null;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error('OPENAI_MODERATION_TIMEOUT'));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
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

const runOpenAiModeration = async ({ text, locale }) => {
	const client = getOpenAiClient();
	if (!client) {
		return {
			flagged: false,
			providerStatus: 'unavailable',
			reasonCodes: [OPENAI_UNAVAILABLE_REASON],
			categories: {},
			categoryScores: {},
			providerMeta: {
				error: 'OPENAI_API_KEY_MISSING',
				locale,
			},
		};
	}

	try {
		const response = await withTimeout(
			client.moderations.create({
				model: CONTENT_MODERATION_CONFIG.openAiModel,
				input: text,
			}),
			CONTENT_MODERATION_CONFIG.openAiTimeoutMs,
		);
		return summarizeOpenAiModeration(response);
	} catch (error) {
		return {
			flagged: false,
			providerStatus: 'unavailable',
			reasonCodes: [OPENAI_UNAVAILABLE_REASON],
			categories: {},
			categoryScores: {},
			providerMeta: {
				error: error?.message || 'OPENAI_PROVIDER_FAILURE',
				locale,
			},
		};
	}
};

const buildVerdictForSurface = (surface, shouldBlock) => {
	if (!shouldBlock) return CONTENT_MODERATION_VERDICTS.ALLOW;
	return surface === CONTENT_MODERATION_SURFACES.CHAT ?
			CONTENT_MODERATION_VERDICTS.AUTO_REMOVE_CHAT
		:	CONTENT_MODERATION_VERDICTS.AUTO_HIDE_COMMENT;
};

const buildDecisionSource = ({ lexicalMatches, openAiSummary }) => {
	if (lexicalMatches.length && openAiSummary.flagged) return 'hybrid';
	if (lexicalMatches.length) {
		return openAiSummary.providerStatus === 'unavailable' ? 'fallback' : 'ldnoobw';
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
	const normalizedLocale = normalizeModerationLocale(locale);
	const normalizedHashSource = normalizeForHash(text);
	const textHash = buildTextHash(normalizedHashSource);
	const cacheKey = `${surface}:${normalizedLocale}:${textHash}`;
	const cached = getCacheEntry(cacheKey);
	if (cached) return cached;

	const lexical = collectLexicalMatches({
		text,
		locale: normalizedLocale,
	});
	const openAiSummary = await runOpenAiModeration({
		text,
		locale: normalizedLocale,
	});

	const lexicalFlagged = lexical.matches.length > 0;
	const shouldBlock = lexicalFlagged || openAiSummary.flagged;
	const recommendedVerdict = buildVerdictForSurface(surface, shouldBlock);
	const enforced =
		CONTENT_MODERATION_CONFIG.mode === 'enforce' && recommendedVerdict !== 'allow';
	const appliedVerdict =
		enforced ? recommendedVerdict : CONTENT_MODERATION_VERDICTS.ALLOW;
	const reasonCodes = Array.from(
		new Set([
			...(lexicalFlagged ? [EXACT_LEXICAL_REASON] : []),
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
	const logEntry = await createContentModerationLog({
		surface,
		surveyId,
		surveyType,
		surveyModel,
		userId,
		userPseudoSnapshot,
		decision,
	});
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

const resetModerationTestState = () => {
	wordlistCache.clear();
	moderationCache.clear();
	openAiClient = null;
};

const setOpenAiClientCtorForTests = (ctor) => {
	OpenAIClientCtor = ctor || null;
	openAiClient = null;
};

module.exports = {
	OPENAI_UNAVAILABLE_REASON,
	EXACT_LEXICAL_REASON,
	moderateContent,
	moderateChatMessage,
	moderateSurveyComment,
	loadWordlistForLocale,
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
		resetModerationTestState,
		setOpenAiClientCtorForTests,
	},
};
