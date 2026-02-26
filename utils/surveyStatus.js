/** @format */

const SURVEY_STATUS_PUBLIC = 'public';
const SURVEY_STATUS_PRIVATE = 'privée';
const SURVEY_STATUS_ENUM = [SURVEY_STATUS_PUBLIC, SURVEY_STATUS_PRIVATE];

const PRIVATE_ALIASES = new Set([
	SURVEY_STATUS_PRIVATE,
	'privee',
	'private',
	'privé',
	'prive',
]);
const PUBLIC_ALIASES = new Set([SURVEY_STATUS_PUBLIC, 'publique']);

const normalizeSurveyStatus = (
	value,
	{ defaultStatus = SURVEY_STATUS_PUBLIC } = {},
) => {
	const normalized = String(value || '').trim().toLowerCase();
	if (PRIVATE_ALIASES.has(normalized)) return SURVEY_STATUS_PRIVATE;
	if (PUBLIC_ALIASES.has(normalized)) return SURVEY_STATUS_PUBLIC;
	return defaultStatus;
};

const isSurveyPrivate = (status) =>
	normalizeSurveyStatus(status, {
		defaultStatus: SURVEY_STATUS_PUBLIC,
	}) === SURVEY_STATUS_PRIVATE;

const isSurveyPublic = (status) => !isSurveyPrivate(status);

module.exports = {
	SURVEY_STATUS_PUBLIC,
	SURVEY_STATUS_PRIVATE,
	SURVEY_STATUS_ENUM,
	normalizeSurveyStatus,
	isSurveyPrivate,
	isSurveyPublic,
};

