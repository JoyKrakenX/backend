/** @format */

const crypto = require('crypto');

const ADJECTIVES = [
	'Nova',
	'Astra',
	'Lumen',
	'Orion',
	'Velvet',
	'Cedar',
	'Solar',
	'Arctic',
	'Sable',
	'Vivid',
	'Zenith',
	'Echo',
	'Prisma',
	'Nimbus',
	'Atlas',
	'Pixel',
	'Aurora',
	'Comet',
	'Lyric',
	'Quartz',
];

const NOUNS = [
	'Cobalt',
	'Harbor',
	'Falcon',
	'Sphere',
	'Drift',
	'Circuit',
	'Beacon',
	'Vertex',
	'Mosaic',
	'Ripple',
	'Pulse',
	'Vector',
	'Signal',
	'Orbit',
	'Prism',
	'Cascade',
	'Voyage',
	'Fusion',
	'Summit',
	'Novae',
];

const toHexHash = (value) =>
	crypto.createHash('sha256').update(String(value || '')).digest('hex');

const toInt = (hexSlice) => Number.parseInt(String(hexSlice || '0'), 16) || 0;

const normalizeId = (value) => String(value || '').trim();
const normalizeGender = (value) =>
	value === 'homme' || value === 'femme' ? value : 'non_renseigne';

const baseAlias = (surveyId, userId) => {
	const digest = toHexHash(`${normalizeId(surveyId)}:${normalizeId(userId)}`);
	const adjective = ADJECTIVES[toInt(digest.slice(0, 8)) % ADJECTIVES.length];
	const noun = NOUNS[toInt(digest.slice(8, 16)) % NOUNS.length];
	const number = (toInt(digest.slice(16, 24)) % 900) + 100;
	return `${adjective}-${noun}-${number}`;
};

const aliasSuffix = (surveyId, userId, attempt) =>
	toHexHash(`${normalizeId(surveyId)}:${normalizeId(userId)}:${attempt}`)
		.slice(0, 3)
		.toUpperCase();

const buildSurveyAlias = (surveyId, userId, attempt = 0) => {
	const base = baseAlias(surveyId, userId);
	if (!attempt) return base;
	return `${base}-${aliasSuffix(surveyId, userId, attempt)}`;
};

const buildSurveyAliasMap = (surveyId, userIds = []) => {
	const normalized = [...new Set(userIds.map(normalizeId).filter(Boolean))].sort();
	const used = new Set();
	const aliases = new Map();

	normalized.forEach((userId) => {
		let attempt = 0;
		let alias = buildSurveyAlias(surveyId, userId, attempt);

		while (used.has(alias) && attempt < 12) {
			attempt += 1;
			alias = buildSurveyAlias(surveyId, userId, attempt);
		}

		used.add(alias);
		aliases.set(userId, alias);
	});

	return aliases;
};

const computeAgeFromBirthdate = (birthdate, now = new Date()) => {
	if (!birthdate) return null;
	const parsedBirthdate = new Date(birthdate);
	const parsedNow = new Date(now);
	if (Number.isNaN(parsedBirthdate.getTime()) || Number.isNaN(parsedNow.getTime())) {
		return null;
	}

	let age = parsedNow.getUTCFullYear() - parsedBirthdate.getUTCFullYear();
	const nowMonth = parsedNow.getUTCMonth();
	const birthMonth = parsedBirthdate.getUTCMonth();
	const nowDay = parsedNow.getUTCDate();
	const birthDay = parsedBirthdate.getUTCDate();

	if (nowMonth < birthMonth || (nowMonth === birthMonth && nowDay < birthDay)) {
		age -= 1;
	}

	if (!Number.isFinite(age) || age < 0) return null;
	return age;
};

const buildVoterKey = (surveyId, userId) =>
	toHexHash(
		`voterKey:${normalizeId(surveyId)}:${normalizeId(userId)}`,
	)
		.slice(0, 12)
		.toUpperCase();

const buildAdminProfilesByUserId = (users = []) => {
	const profiles = new Map();
	const now = new Date();

	(users || []).forEach((user) => {
		const userId = normalizeId(user?._id);
		if (!userId) return;

		profiles.set(userId, {
			age: computeAgeFromBirthdate(user?.birthdate, now),
			gender: normalizeGender(user?.gender),
		});
	});

	return profiles;
};

const toSafeOpinion = (opinion = {}) => ({
	_id: opinion?._id,
	answer: opinion?.answer,
	reason: opinion?.reason,
	createdAt: opinion?.createdAt,
	likeCount: Number(opinion?.likeCount || 0),
	dislikeCount: Number(opinion?.dislikeCount || 0),
	userLiked: Boolean(opinion?.userLiked),
	userDisliked: Boolean(opinion?.userDisliked),
});

const anonymizeOpinionsForSurvey = (
	opinions,
	surveyId,
	{
		includeAdminProfile = false,
		includeVoterKey = false,
		adminProfilesByUserId = null,
		requesterUserId = null,
	} = {},
) => {
	const safeOpinions = Array.isArray(opinions) ? opinions : [];
	const aliasMap = buildSurveyAliasMap(
		surveyId,
		safeOpinions.map((opinion) => opinion?.userId),
	);
	const profileMap =
		adminProfilesByUserId instanceof Map ? adminProfilesByUserId : new Map();

	return safeOpinions.map((opinion) => {
		const userId = normalizeId(opinion?.userId);
		const alias =
			(userId && aliasMap.get(userId)) || buildSurveyAlias(surveyId, userId || 'guest');
		const isOwnOpinion =
			Boolean(requesterUserId) &&
			Boolean(userId) &&
			String(userId) === String(requesterUserId);

		const output = {
			...toSafeOpinion(opinion),
			userPseudo: alias,
			isOwnOpinion,
		};

		if (includeAdminProfile) {
			output.adminProfile = profileMap.get(userId) || {
				age: null,
				gender: 'non_renseigne',
			};
		}
		if (includeVoterKey) {
			output.voterKey = buildVoterKey(surveyId, userId || 'guest');
		}

		return output;
	});
};

module.exports = {
	buildSurveyAlias,
	buildSurveyAliasMap,
	buildVoterKey,
	computeAgeFromBirthdate,
	buildAdminProfilesByUserId,
	anonymizeOpinionsForSurvey,
};
