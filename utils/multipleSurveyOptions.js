/** @format */

const MIN_MULTIPLE_OPTIONS = 2;
const MAX_MULTIPLE_OPTIONS = 6;
const LEGACY_OPTION_KEYS = Array.from(
	{ length: MAX_MULTIPLE_OPTIONS },
	(_, index) => `reponse_${index + 1}`,
);

const sanitizeOptionValue = (value) => String(value || '').trim();

const optionKeyToIndex = (optionKey) => {
	const match = String(optionKey || '').match(/^reponse_(\d+)$/);
	if (!match) return -1;
	const parsed = Number(match[1]);
	return Number.isFinite(parsed) ? parsed - 1 : -1;
};

const sortOptionKeys = (optionKeys = []) =>
	[...optionKeys].sort((left, right) => optionKeyToIndex(left) - optionKeyToIndex(right));

const buildOptionKeys = (options = []) =>
	Array.from({ length: options.length }, (_, index) => `reponse_${index + 1}`);

const extractIncomingOptions = (payload = {}) => {
	if (Array.isArray(payload.options)) {
		return payload.options.map(sanitizeOptionValue);
	}

	const hasLegacyOptionField = LEGACY_OPTION_KEYS.some((key) =>
		Object.prototype.hasOwnProperty.call(payload, key),
	);

	if (hasLegacyOptionField) {
		return LEGACY_OPTION_KEYS.filter((key) =>
			Object.prototype.hasOwnProperty.call(payload, key),
		).map((key) => sanitizeOptionValue(payload[key]));
	}

	return LEGACY_OPTION_KEYS.map((key) => sanitizeOptionValue(payload[key])).filter(Boolean);
};

const resolveSurveyOptions = (survey = {}) => {
	const modernOptions = Array.isArray(survey.options)
		? survey.options.map(sanitizeOptionValue).filter(Boolean)
		: [];

	if (modernOptions.length) {
		return modernOptions.slice(0, MAX_MULTIPLE_OPTIONS);
	}

	return LEGACY_OPTION_KEYS.map((key) => sanitizeOptionValue(survey[key]))
		.filter(Boolean)
		.slice(0, MAX_MULTIPLE_OPTIONS);
};

const validateOptions = (options = []) => {
	if (!Array.isArray(options)) {
		return {
			valid: false,
			code: 'OPTIONS_INVALID_TYPE',
			message: 'Le format des options est invalide.',
		};
	}

	if (options.length < MIN_MULTIPLE_OPTIONS) {
		return {
			valid: false,
			code: 'OPTIONS_MIN_REQUIRED',
			message: `Au moins ${MIN_MULTIPLE_OPTIONS} options sont requises.`,
		};
	}

	if (options.length > MAX_MULTIPLE_OPTIONS) {
		return {
			valid: false,
			code: 'OPTIONS_MAX_EXCEEDED',
			message: `Le maximum est de ${MAX_MULTIPLE_OPTIONS} options.`,
		};
	}

	for (let index = 0; index < options.length; index += 1) {
		if (!sanitizeOptionValue(options[index])) {
			return {
				valid: false,
				code: 'OPTIONS_EMPTY_VALUE',
				message: `L'option ${index + 1} est vide.`,
			};
		}
	}

	const normalized = options.map((value) => sanitizeOptionValue(value).toLowerCase());
	const seen = new Set();
	for (let index = 0; index < normalized.length; index += 1) {
		const value = normalized[index];
		if (seen.has(value)) {
			return {
				valid: false,
				code: 'OPTIONS_DUPLICATE',
				message: 'Les options doivent etre uniques.',
			};
		}
		seen.add(value);
	}

	return { valid: true };
};

const normalizeValidatedOptions = (options = []) =>
	options.map((value) => sanitizeOptionValue(value)).filter(Boolean);

const buildLabelsMapFromOptions = (options = []) => {
	const labels = {};
	buildOptionKeys(options).forEach((key, index) => {
		labels[key] = options[index];
	});
	return labels;
};

const buildLegacyOptionFields = (options = []) => {
	const fields = {};
	for (let index = 0; index < MAX_MULTIPLE_OPTIONS; index += 1) {
		fields[`reponse_${index + 1}`] = options[index] || null;
	}
	return fields;
};

const buildSurveyOptionPayload = (survey = {}) => {
	const options = resolveSurveyOptions(survey);
	const optionKeys = buildOptionKeys(options);
	const labels = buildLabelsMapFromOptions(options);
	const legacyFields = buildLegacyOptionFields(options);
	return {
		options,
		optionKeys,
		labels,
		legacyFields,
	};
};

const isChoiceAllowed = (choice, options = []) => {
	const normalizedChoice = String(choice || '').trim();
	if (!normalizedChoice) return false;
	return buildOptionKeys(options).includes(normalizedChoice);
};

const buildCountsMap = (optionKeys = [], source = {}) =>
	optionKeys.reduce((accumulator, key) => {
		accumulator[key] = Number(source[key] || 0);
		return accumulator;
	}, {});

const buildCountsMapFromOpinions = (opinions = [], optionKeys = []) => {
	const counts = optionKeys.reduce((accumulator, key) => {
		accumulator[key] = 0;
		return accumulator;
	}, {});

	(opinions || []).forEach((opinion) => {
		const key = String(opinion?.answer || '').trim();
		if (Object.prototype.hasOwnProperty.call(counts, key)) {
			counts[key] += 1;
		}
	});

	return counts;
};

const aggregateCountsByOptionKeys = async (OpinionModel, surveyId, optionKeys = []) => {
	const counts = optionKeys.reduce((accumulator, key) => {
		accumulator[key] = 0;
		return accumulator;
	}, {});

	if (!OpinionModel || !surveyId || !optionKeys.length) {
		return { counts, totalOpinions: 0 };
	}

	const aggregated = await OpinionModel.aggregate([
		{ $match: { surveyId } },
		{ $group: { _id: '$answer', total: { $sum: 1 } } },
	]);

	(aggregated || []).forEach((entry) => {
		const key = String(entry?._id || '').trim();
		if (Object.prototype.hasOwnProperty.call(counts, key)) {
			counts[key] = Number(entry.total || 0);
		}
	});

	const totalOpinions = optionKeys.reduce(
		(total, key) => total + Number(counts[key] || 0),
		0,
	);

	return { counts, totalOpinions };
};

module.exports = {
	MIN_MULTIPLE_OPTIONS,
	MAX_MULTIPLE_OPTIONS,
	LEGACY_OPTION_KEYS,
	sortOptionKeys,
	sanitizeOptionValue,
	extractIncomingOptions,
	resolveSurveyOptions,
	validateOptions,
	normalizeValidatedOptions,
	buildOptionKeys,
	buildLabelsMapFromOptions,
	buildLegacyOptionFields,
	buildSurveyOptionPayload,
	isChoiceAllowed,
	buildCountsMap,
	buildCountsMapFromOpinions,
	aggregateCountsByOptionKeys,
};

