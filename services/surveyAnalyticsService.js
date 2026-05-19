/** @format */

const crypto = require('crypto');
const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const OpinionFlash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const SurveyAnalyticsEvent = require('../models/SurveyAnalyticsEvent');
const {
	canManageSurveyByOrganization,
} = require('./surveyAuthorizationService');
const {
	buildAdminProfilesByUserId,
} = require('../utils/commentAnonymizer');

const SOURCE_VALUES = new Set(['tv', 'social', 'direct']);
const SOCIAL_HOST_RE = /(facebook|instagram|twitter|x\.com|tiktok|youtube|youtu\.be|linkedin|whatsapp|telegram|threads|snapchat)/i;

const toId = (value) => String(value || '').trim();
const toDate = (value) => {
	if (value === null || value === undefined || value === '') return null;
	const date = value instanceof Date ? value : new Date(value || 0);
	return Number.isNaN(date.getTime()) ? null : date;
};
const pct = (value, total) =>
	total > 0 ? Math.round((Number(value || 0) / Number(total || 0)) * 100) : 0;

function normalizeScanSource(value, referrer = '') {
	const raw = String(value || '').trim().toLowerCase();
	if (SOURCE_VALUES.has(raw)) return raw;
	if (['fb', 'facebook', 'instagram', 'twitter', 'x', 'linkedin', 'whatsapp', 'tiktok'].includes(raw)) {
		return 'social';
	}
	const ref = String(referrer || '').trim();
	if (SOCIAL_HOST_RE.test(ref)) return 'social';
	if (ref) {
		try {
			const host = new URL(ref).hostname;
			if (SOCIAL_HOST_RE.test(host)) return 'social';
			if (/community-web\.com$/i.test(host)) return 'direct';
		} catch (_error) {
			return 'direct';
		}
	}
	return 'direct';
}

function normalizeCountryFromRequest(req) {
	const headers = req?.headers || {};
	const rawCode = String(
		headers['cf-ipcountry'] ||
			headers['x-vercel-ip-country'] ||
			headers['x-country-code'] ||
			headers['x-geo-country'] ||
			headers['cloudfront-viewer-country'] ||
			'',
	)
		.trim()
		.toUpperCase();
	const code = /^[A-Z]{2}$/.test(rawCode) ? rawCode : 'XX';
	return {
		countryCode: code,
		countryName: code === 'XX' ? 'Unknown' : code,
	};
}

function getReferrerHost(referrer = '') {
	try {
		return new URL(String(referrer || '')).hostname.slice(0, 180);
	} catch (_error) {
		return '';
	}
}

function minuteKey(value) {
	const date = toDate(value);
	if (!date) return null;
	date.setUTCSeconds(0, 0);
	return date.toISOString();
}

function countBy(items, keyFn) {
	const map = new Map();
	(items || []).forEach((item) => {
		const key = keyFn(item);
		if (!key) return;
		map.set(key, (map.get(key) || 0) + 1);
	});
	return map;
}

function bucketByMinute(items) {
	return Array.from(countBy(items, (item) => minuteKey(item?.createdAt)).entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([minute, count]) => ({ minute, count }));
}

function topFromMap(map, limit = 5, mapper = (key, count) => ({ key, count })) {
	return Array.from(map.entries())
		.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
		.slice(0, limit)
		.map(([key, count]) => mapper(key, count));
}

function getUserKey(item) {
	return toId(item?.userId || item?.user?._id || item?.user?.id);
}

function uniqueUsers(items) {
	return new Set((items || []).map(getUserKey).filter(Boolean));
}

function resolveAnswerKey(opinion, type) {
	if (type === 'binary') return opinion?.answer === true ? 'yes' : 'no';
	return String(opinion?.answer || 'unknown').trim() || 'unknown';
}

function buildOpinionTimeline({ opinions = [], type = 'binary', labels = {} } = {}) {
	const sorted = [...opinions].sort(
		(a, b) => (toDate(a?.createdAt)?.getTime() || 0) - (toDate(b?.createdAt)?.getTime() || 0),
	);
	const counts = {};
	const rows = [];
	let previousLeader = null;
	let firstLeaderChangeAt = null;
	let yesOverNoAt = null;
	let dominantAt = null;

	sorted.forEach((opinion) => {
		const key = resolveAnswerKey(opinion, type);
		counts[key] = Number(counts[key] || 0) + 1;
		const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
		const ordered = Object.entries(counts).sort((a, b) => b[1] - a[1]);
		const leader = ordered[0] || [key, 0];
		const runnerUp = ordered[1] || [null, 0];
		const leaderKey = leader[0];
		const leaderChanged = leaderKey && leaderKey !== previousLeader;
		if (leaderChanged && !firstLeaderChangeAt) {
			firstLeaderChangeAt = toDate(opinion.createdAt)?.toISOString() || null;
		}
		if (
			type === 'binary' &&
			!yesOverNoAt &&
			Number(counts.yes || 0) > Number(counts.no || 0)
		) {
			yesOverNoAt = toDate(opinion.createdAt)?.toISOString() || null;
		}
		if (
			!dominantAt &&
			total >= 5 &&
			leader[1] > runnerUp[1] &&
			pct(leader[1], total) >= 50 &&
			pct(leader[1] - runnerUp[1], total) >= 10
		) {
			dominantAt = toDate(opinion.createdAt)?.toISOString() || null;
		}
		previousLeader = leaderKey || previousLeader;
		rows.push({
			at: toDate(opinion.createdAt)?.toISOString() || null,
			total,
			leaderKey,
			leaderLabel: labels[leaderKey] || leaderKey,
			counts: { ...counts },
			percentages: Object.fromEntries(
				Object.entries(counts).map(([entryKey, value]) => [entryKey, pct(value, total)]),
			),
		});
	});

	const first = toDate(sorted[0]?.createdAt);
	const last = toDate(sorted[sorted.length - 1]?.createdAt);
	const elapsedMinutes =
		first && last ? Math.max(1, Math.ceil((last.getTime() - first.getTime()) / 60000)) : 1;

	return {
		timeline: rows,
		votesPerMinute: bucketByMinute(sorted),
		peakVotesMinute: topFromMap(countBy(sorted, (item) => minuteKey(item.createdAt)), 1, (minute, count) => ({ minute, count }))[0] || null,
		firstLeaderChangeAt,
		yesOverNoAt,
		dominantAt,
		voteVelocityPerMinute: Number((sorted.length / elapsedMinutes).toFixed(2)),
	};
}

function ageBand(age) {
	const value = Number(age);
	if (!Number.isFinite(value)) return 'Non renseigné';
	if (value < 18) return '13-17';
	if (value <= 24) return '18-24';
	if (value <= 34) return '25-34';
	if (value <= 44) return '35-44';
	if (value <= 54) return '45-54';
	return '55+';
}

function labelGender(value) {
	const normalized = String(value || '').trim().toLowerCase();
	if (normalized === 'homme') return 'homme';
	if (normalized === 'femme') return 'femme';
	return 'non_renseigne';
}

function buildProfile({ opinions = [], scanEvents = [], type = 'binary' }) {
	const scanById = new Map(
		(scanEvents || []).map((event) => [String(event.scanId || ''), event]).filter(([key]) => key),
	);
	const allScanCountryCounts = countBy(
		scanEvents || [],
		(event) => `${String(event.countryCode || 'XX').toUpperCase()}|${event.countryName || 'Unknown'}`,
	);
	const ageCounts = new Map();
	const genderCounts = new Map();
	const countryCounts = new Map();
	const byOption = {};

	(opinions || []).forEach((opinion) => {
		const option = resolveAnswerKey(opinion, type);
		const profile = opinion?.adminProfile || {};
		const band = ageBand(profile.age);
		const gender = labelGender(profile.gender);
		const scan = scanById.get(String(opinion?.scanId || ''));
		ageCounts.set(band, (ageCounts.get(band) || 0) + 1);
		genderCounts.set(gender, (genderCounts.get(gender) || 0) + 1);
		const countryCode = String(scan?.countryCode || '').toUpperCase();
		const countryName = String(scan?.countryName || '');
		if (countryCode) {
			const countryKey = `${countryCode}|${countryName || countryCode}`;
			countryCounts.set(countryKey, (countryCounts.get(countryKey) || 0) + 1);
		}
		byOption[option] ||= { ages: {}, genders: {}, countries: {} };
		byOption[option].ages[band] = Number(byOption[option].ages[band] || 0) + 1;
		byOption[option].genders[gender] = Number(byOption[option].genders[gender] || 0) + 1;
		if (countryCode) {
			byOption[option].countries[countryCode] = Number(byOption[option].countries[countryCode] || 0) + 1;
		}
	});

	const topAge = topFromMap(ageCounts, 1, (label, count) => ({ label, count }))[0] || {
		label: 'Non renseigné',
		count: 0,
	};
	const topGender = topFromMap(genderCounts, 1, (label, count) => ({ label, count }))[0] || {
		label: 'non_renseigne',
		count: 0,
	};
	const sortedCountryEntries = Array.from(countryCounts.entries()).sort(
		(a, b) =>
			b[1] - a[1] ||
			Number(allScanCountryCounts.get(b[0]) || 0) - Number(allScanCountryCounts.get(a[0]) || 0) ||
			String(a[0]).localeCompare(String(b[0])),
	);
	const countryEntries = sortedCountryEntries.length ? sortedCountryEntries : Array.from(allScanCountryCounts.entries());
	const topCountry = countryEntries.slice(0, 1).map(([key, count]) => {
		const [countryCode, countryName] = String(key).split('|');
		return { countryCode, countryName, count };
	})[0] || { countryCode: 'XX', countryName: 'Unknown', count: 0 };

	return {
		topAgeBand: topAge,
		dominantGender: topGender,
		dominantCountry: topCountry,
		ageBands: topFromMap(ageCounts, 8, (label, count) => ({ label, count })),
		genders: topFromMap(genderCounts, 4, (label, count) => ({ label, count })),
		countries: countryEntries.slice(0, 5).map(([key, count]) => {
			const [countryCode, countryName] = String(key).split('|');
			return { countryCode, countryName, count };
		}),
		byOption,
	};
}

function buildAdminAnalyticsSnapshot({
	survey = {},
	type = 'binary',
	labels = {},
	currentOpinions = [],
	previousOpinions = [],
	scanEvents = [],
	chatMessages = [],
	previousChatMessages = [],
	emojiEvents = [],
	activeUsersCount = 0,
	now = new Date(),
} = {}) {
	const scans = (scanEvents || []).filter((event) => String(event?.eventType || event?.type || 'scan') === 'scan');
	const scanById = new Map(scans.map((event) => [String(event.scanId || ''), event]).filter(([key]) => key));
	const linkedVoteDelays = [];
	(currentOpinions || []).forEach((opinion) => {
		const scan = scanById.get(String(opinion?.scanId || ''));
		const scanAt = toDate(scan?.createdAt);
		const voteAt = toDate(opinion?.createdAt);
		if (scanAt && voteAt && voteAt >= scanAt) {
			linkedVoteDelays.push(Math.round((voteAt.getTime() - scanAt.getTime()) / 1000));
		}
	});

	const sources = { tv: 0, social: 0, direct: 0 };
	scans.forEach((event) => {
		const source = normalizeScanSource(event.source);
		sources[source] = Number(sources[source] || 0) + 1;
	});

	const knownCountryScans = scans.filter((event) => {
		const code = String(event.countryCode || 'XX').toUpperCase();
		const name = String(event.countryName || '').trim().toLowerCase();
		return code !== 'XX' && name && name !== 'unknown' && name !== 'inconnu';
	});
	const countriesMap = countBy(knownCountryScans, (event) => `${String(event.countryCode || 'XX').toUpperCase()}|${event.countryName || event.countryCode}`);
	const currentUsers = uniqueUsers(currentOpinions);
	const previousUsers = uniqueUsers(previousOpinions);
	const chatUsers = uniqueUsers(chatMessages);
	const previousChatUsers = uniqueUsers(previousChatMessages);
	const returningVoters = [...currentUsers].filter((userId) => previousUsers.has(userId)).length;
	const returningChatParticipants = [...chatUsers].filter((userId) => previousChatUsers.has(userId)).length;
	const voterChatOverlap = [...chatUsers].filter((userId) => currentUsers.has(userId)).length;
	const opinionDynamics = buildOpinionTimeline({ opinions: currentOpinions, type, labels });
	const chatMinuteMap = countBy(chatMessages, (message) => minuteKey(message.createdAt));
	const emojiMinuteMap = countBy(
		emojiEvents,
		(event) => `${minuteKey(event.createdAt)}|${String(event?.metadata?.emoji || event?.emoji || '')}`,
	);
	const totalVotes = currentOpinions.length;
	const totalScans = scans.length;
	const reliabilityLevel =
		totalVotes >= 300 ? 'solid'
		: totalVotes >= 50 ? 'exploratory'
		: 'weak';

	return {
		generatedAt: toDate(now)?.toISOString() || new Date().toISOString(),
		surveyId: toId(survey._id),
		type,
		acquisition: {
			totalScans,
			topCountries: topFromMap(countriesMap, 5, (key, count) => {
				const [countryCode, countryName] = String(key).split('|');
				return { countryCode, countryName, count };
			}),
			scansPerMinute: bucketByMinute(scans),
			sources,
		},
		conversion: {
			votersRealtime: totalVotes,
			scanToVoteRate: pct(linkedVoteDelays.length, totalScans),
			averageScanToVoteSeconds:
				linkedVoteDelays.length > 0 ?
					Math.round(linkedVoteDelays.reduce((sum, value) => sum + value, 0) / linkedVoteDelays.length)
				:	0,
			votesPerMinute: opinionDynamics.votesPerMinute,
			peakVotesMinute: opinionDynamics.peakVotesMinute,
			currentSurveyVoters: currentUsers.size,
			previousSurveyVoters: previousUsers.size,
			returningVotersFromPreviousSurvey: returningVoters,
		},
		opinions: opinionDynamics,
		chat: {
			totalMessages: chatMessages.length,
			activeParticipants: chatUsers.size,
			activeUsersRealtime: Number(activeUsersCount || 0),
			messagesPerMinute: bucketByMinute(chatMessages),
			peakMessagesMinute: topFromMap(chatMinuteMap, 1, (minute, count) => ({ minute, count }))[0] || null,
			chatBecameActiveAt: topFromMap(chatMinuteMap, 1, (minute, count) => ({ minute, count }))[0]?.minute || null,
			voterToChatParticipantRate: pct(voterChatOverlap, totalVotes),
			returningChatParticipants,
			topEmojiPeaks: topFromMap(emojiMinuteMap, 10, (key, count) => {
				const [minute, emoji] = String(key).split('|');
				return { minute, emoji, count };
			}),
		},
		profile: buildProfile({ opinions: currentOpinions, scanEvents: scans, type }),
		retention: {
			returningVoters,
			returningChatParticipants,
			voterRetentionRate: pct(returningVoters, previousUsers.size),
			chatRetentionRate: pct(returningChatParticipants, previousChatUsers.size),
			surveyWithMostReturn: null,
		},
		reliability: {
			level: reliabilityLevel,
			voteCount: totalVotes,
			note:
				'Community mesure une audience participante active, pas une audience TV representative totale.',
		},
	};
}

function resolveModels(type, flash = false) {
	const isMultiple = type === 'multiple';
	return {
		surveyModel: isMultiple ? Survey_2 : Survey,
		surveyModelName: isMultiple ? 'Survey_2' : 'Survey',
		opinionModel:
			isMultiple ?
				flash ? Opinion_2_Flash : Opinion_2
			:	flash ? OpinionFlash : Opinion,
	};
}

async function findPreviousSurveyContext(survey) {
	const queryBase = {
		createdAt: { $lt: survey.createdAt || new Date() },
	};
	if (survey.organizationId) {
		queryBase.organizationId = survey.organizationId;
	} else if (survey.userId) {
		queryBase.userId = survey.userId;
	}
	const [binary, multiple] = await Promise.all([
		Survey.findOne(queryBase).sort({ createdAt: -1 }).lean(),
		Survey_2.findOne(queryBase).sort({ createdAt: -1 }).lean(),
	]);
	const candidates = [
		binary ? { survey: binary, type: 'binary' } : null,
		multiple ? { survey: multiple, type: 'multiple' } : null,
	].filter(Boolean);
	candidates.sort(
		(a, b) => (toDate(b.survey.createdAt)?.getTime() || 0) - (toDate(a.survey.createdAt)?.getTime() || 0),
	);
	return candidates[0] || null;
}

async function getOpinionsWithProfiles(opinionModel, surveyId) {
	const opinions = await opinionModel.find({ surveyId }).sort({ createdAt: 1 }).lean();
	const userIds = [...new Set(opinions.map((opinion) => toId(opinion.userId)).filter(Boolean))];
	const users =
		userIds.length > 0 ?
			await User.find({ _id: { $in: userIds } }).select('birthdate gender').lean()
		:	[];
	const profiles = buildAdminProfilesByUserId(users);
	return opinions.map((opinion) => ({
		...opinion,
		adminProfile: profiles.get(toId(opinion.userId)) || {
			age: null,
			gender: 'non_renseigne',
		},
	}));
}

async function getAdminAnalytics({ surveyId, type, flash = false, requesterUserId, io = null }) {
	if (!mongoose.Types.ObjectId.isValid(surveyId)) {
		const error = new Error('Identifiant de sondage invalide.');
		error.status = 400;
		throw error;
	}
	const models = resolveModels(type, flash);
	const survey = await models.surveyModel.findById(surveyId).lean();
	if (!survey) {
		const error = new Error('Sondage introuvable.');
		error.status = 404;
		throw error;
	}
	const canManage = await canManageSurveyByOrganization(survey, requesterUserId);
	if (!canManage) {
		const error = new Error('Acces admin requis.');
		error.status = 403;
		throw error;
	}

	const previous = await findPreviousSurveyContext(survey);
	const previousModels = previous ? resolveModels(previous.type, previous.survey.explain === false) : null;
	const previousSurveyId = previous?.survey?._id || null;
	const room = `survey-${String(survey._id)}`;
	const activeUsersCount = Number(io?.chatPresence?.get?.(room)?.size || 0);
	const [currentOpinions, previousOpinions, scanEvents, chatMessages, previousChatMessages, emojiEvents] =
		await Promise.all([
			getOpinionsWithProfiles(models.opinionModel, survey._id),
			previousModels && previousSurveyId ? previousModels.opinionModel.find({ surveyId: previousSurveyId }).lean() : [],
			SurveyAnalyticsEvent.find({ surveyId: survey._id, eventType: 'scan' }).sort({ createdAt: 1 }).lean(),
			ChatMessage.find({ surveyId: survey._id }).sort({ createdAt: 1 }).lean(),
			previousSurveyId ? ChatMessage.find({ surveyId: previousSurveyId }).lean() : [],
			SurveyAnalyticsEvent.find({ surveyId: survey._id, eventType: 'chat_emoji' }).sort({ createdAt: 1 }).lean(),
		]);

	return buildAdminAnalyticsSnapshot({
		survey,
		type,
		labels: survey.labels || survey.binaryLabels || {},
		currentOpinions,
		previousOpinions,
		scanEvents,
		chatMessages,
		previousChatMessages,
		emojiEvents,
		activeUsersCount,
	});
}

async function recordScan({ req, surveyId, type, flash = false, source }) {
	const models = resolveModels(type, flash);
	const survey = await models.surveyModel.findById(surveyId).select('_id').lean();
	if (!survey) {
		const error = new Error('Sondage introuvable.');
		error.status = 404;
		throw error;
	}
	const referrer = String(req?.headers?.referer || req?.headers?.referrer || '');
	const scanId = crypto.randomUUID();
	const country = normalizeCountryFromRequest(req);
	const event = await SurveyAnalyticsEvent.create({
		surveyId,
		surveyModel: models.surveyModelName,
		eventType: 'scan',
		scanId,
		source: normalizeScanSource(source || req?.query?.source || req?.body?.source, referrer),
		referrerHost: getReferrerHost(referrer),
		...country,
		metadata: {
			pathname: String(req?.body?.pathname || ''),
		},
	});
	return {
		scanId: event.scanId,
		source: event.source,
		countryCode: event.countryCode,
		countryName: event.countryName,
	};
}

async function recordVoteConversion({
	surveyId,
	type,
	flash = false,
	scanId,
	userId,
	opinionId,
	answer,
}) {
	const normalizedScanId = String(scanId || '').trim();
	if (!normalizedScanId || !mongoose.Types.ObjectId.isValid(surveyId)) return null;
	const models = resolveModels(type, flash);
	const scan = await SurveyAnalyticsEvent.findOne({
		surveyId,
		scanId: normalizedScanId,
		eventType: 'scan',
	}).lean();
	const createdAt = new Date();
	const scanAt = toDate(scan?.createdAt);
	const elapsedMs = scanAt ? Math.max(0, createdAt.getTime() - scanAt.getTime()) : null;
	return SurveyAnalyticsEvent.create({
		surveyId,
		surveyModel: models.surveyModelName,
		eventType: 'vote_conversion',
		scanId: normalizedScanId,
		source: normalizeScanSource(scan?.source),
		countryCode: scan?.countryCode || 'XX',
		countryName: scan?.countryName || 'Unknown',
		userId: userId || null,
		metadata: {
			opinionId: toId(opinionId),
			answer,
			elapsedMs,
		},
		createdAt,
	});
}

async function recordChatEmoji({ surveyId, type, emoji, userId }) {
	if (!mongoose.Types.ObjectId.isValid(surveyId)) return null;
	const models = resolveModels(type, false);
	return SurveyAnalyticsEvent.create({
		surveyId,
		surveyModel: models.surveyModelName,
		eventType: 'chat_emoji',
		userId: userId || null,
		metadata: {
			emoji: String(emoji || '').trim().slice(0, 16),
		},
	});
}

async function emitAdminAnalyticsUpdate(io, { surveyId, type, flash = false }) {
	if (!io || !surveyId || !type) return;
	const payload = {
		surveyId: String(surveyId),
		type,
		flash: Boolean(flash),
		updatedAt: new Date().toISOString(),
	};
	io.to(`survey-analytics:${String(surveyId)}`).emit('analytics:update', payload);
	io.to(`classic-${type}-${String(surveyId)}`).emit('analytics:update', payload);
	io.to(type === 'multiple' ? `flash-multiple-${String(surveyId)}` : `flash-binary-${String(surveyId)}`).emit('analytics:update', payload);
}

module.exports = {
	buildAdminAnalyticsSnapshot,
	emitAdminAnalyticsUpdate,
	getAdminAnalytics,
	normalizeCountryFromRequest,
	normalizeScanSource,
	recordChatEmoji,
	recordScan,
	recordVoteConversion,
	resolveModels,
};
