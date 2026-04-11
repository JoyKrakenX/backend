/** @format */

const SUPPORTED_MODERATION_LOCALES = Object.freeze(['fr', 'en', 'es', 'de']);
const CONTENT_MODERATION_MODES = Object.freeze(['shadow', 'enforce']);
const CONTENT_MODERATION_SURFACES = Object.freeze({
	CHAT: 'chat_message',
	SURVEY_COMMENT: 'survey_comment',
});
const CONTENT_MODERATION_VERDICTS = Object.freeze({
	ALLOW: 'allow',
	AUTO_REMOVE_CHAT: 'auto_remove_chat',
	AUTO_HIDE_COMMENT: 'auto_hide_comment',
});
const CONTENT_MODERATION_SOURCES = Object.freeze([
	'openai',
	'ldnoobw',
	'profanity_csv',
	'hybrid',
	'fallback',
]);

const parseBoolean = (value, fallback = false) => {
	const normalized = String(value ?? '').trim().toLowerCase();
	if (!normalized) return fallback;
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	return fallback;
};

const parseNumber = (value, fallback) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeModerationMode = (value) => {
	const normalized = String(value || 'shadow').trim().toLowerCase();
	return CONTENT_MODERATION_MODES.includes(normalized) ? normalized : 'shadow';
};

const normalizeModerationLocale = (value) => {
	const normalized = String(value || '').trim().toLowerCase();
	return SUPPORTED_MODERATION_LOCALES.includes(normalized) ? normalized : 'fr';
};

const CONTENT_MODERATION_CONFIG = Object.freeze({
	enabled: parseBoolean(process.env.CONTENT_MODERATION_ENABLED, true),
	mode: normalizeModerationMode(process.env.CONTENT_MODERATION_MODE),
	chatEnabled: parseBoolean(process.env.CONTENT_MODERATION_CHAT_ENABLED, true),
	surveyCommentsEnabled: parseBoolean(
		process.env.CONTENT_MODERATION_SURVEY_COMMENTS_ENABLED,
		true,
	),
	openAiModel: String(
		process.env.CONTENT_MODERATION_OPENAI_MODEL || 'omni-moderation-latest',
	).trim(),
	openAiTimeoutMs: Math.max(
		500,
		parseNumber(process.env.CONTENT_MODERATION_OPENAI_TIMEOUT_MS, 1200),
	),
	openAiCooldownMs: Math.max(
		1000,
		parseNumber(process.env.CONTENT_MODERATION_OPENAI_COOLDOWN_MS, 60 * 1000),
	),
	logRetentionDays: Math.max(
		7,
		parseNumber(process.env.CONTENT_MODERATION_LOG_RETENTION_DAYS, 45),
	),
	cacheTtlMs: Math.max(
		1000,
		parseNumber(process.env.CONTENT_MODERATION_CACHE_TTL_MS, 5 * 60 * 1000),
	),
	maxPreviewLength: Math.max(
		80,
		parseNumber(process.env.CONTENT_MODERATION_PREVIEW_LIMIT, 280),
	),
	logAllowDecisions: parseBoolean(
		process.env.CONTENT_MODERATION_LOG_ALLOW_DECISIONS,
		false,
	),
});

module.exports = {
	SUPPORTED_MODERATION_LOCALES,
	CONTENT_MODERATION_MODES,
	CONTENT_MODERATION_SURFACES,
	CONTENT_MODERATION_VERDICTS,
	CONTENT_MODERATION_SOURCES,
	CONTENT_MODERATION_CONFIG,
	parseBoolean,
	parseNumber,
	normalizeModerationMode,
	normalizeModerationLocale,
};
