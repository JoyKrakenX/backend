/** @format */

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const User = require('../models/User');
const ChatMessage = require('../models/ChatMessage');

const WINDOW_MONTHS = 6;
const ACTIVE_WINDOW_DAYS = 30;

const toDate = (year, month, day = 1) => new Date(Date.UTC(year, month, day, 0, 0, 0, 0));

const addMonthsUtc = (date, delta) =>
	toDate(date.getUTCFullYear(), date.getUTCMonth() + delta, 1);

const monthLabel = (date) =>
	new Intl.DateTimeFormat('fr-FR', {
		month: 'short',
		year: '2-digit',
		timeZone: 'UTC',
	}).format(date);

const idToString = (value) => String(value || '').trim();

const collectDistinctUsers = async (start, end) => {
	const range = { $gte: start, $lt: end };
	const [surveyUsers, survey2Users, opinionUsers, opinion2Users, chatUsers] =
		await Promise.all([
			Survey.distinct('userId', { createdAt: range }),
			Survey_2.distinct('userId', { createdAt: range }),
			Opinion.distinct('userId', { createdAt: range }),
			Opinion_2.distinct('userId', { createdAt: range }),
			ChatMessage.distinct('userId', { createdAt: range }),
		]);

	return new Set(
		[
			...surveyUsers,
			...survey2Users,
			...opinionUsers,
			...opinion2Users,
			...chatUsers,
		]
			.map(idToString)
			.filter(Boolean),
	);
};

exports.getPlatformMetrics = async (_req, res) => {
	try {
		const now = new Date();
		const activeStart = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

		const [
			totalUsers,
			totalSurveyBinary,
			totalSurveyMultiple,
			totalOpinionsBinary,
			totalOpinionsMultiple,
			activeUsersSet,
		] = await Promise.all([
			User.countDocuments(),
			Survey.countDocuments(),
			Survey_2.countDocuments(),
			Opinion.countDocuments(),
			Opinion_2.countDocuments(),
			collectDistinctUsers(activeStart, now),
		]);

		const monthStarts = [];
		const currentMonthStart = toDate(now.getUTCFullYear(), now.getUTCMonth(), 1);
		for (let offset = WINDOW_MONTHS - 1; offset >= 0; offset -= 1) {
			monthStarts.push(addMonthsUtc(currentMonthStart, -offset));
		}

		const monthlySeries = [];
		for (let index = 0; index < monthStarts.length; index += 1) {
			const start = monthStarts[index];
			const end = index === monthStarts.length - 1 ? addMonthsUtc(start, 1) : monthStarts[index + 1];
			const [binaryCount, multipleCount, activeSet] = await Promise.all([
				Survey.countDocuments({ createdAt: { $gte: start, $lt: end } }),
				Survey_2.countDocuments({ createdAt: { $gte: start, $lt: end } }),
				collectDistinctUsers(start, end),
			]);

			monthlySeries.push({
				label: monthLabel(start),
				surveysCreated: Number(binaryCount || 0) + Number(multipleCount || 0),
				activeUsers: activeSet.size,
			});
		}

		return res.status(200).json({
			generatedAt: now.toISOString(),
			windowMonths: WINDOW_MONTHS,
			summary: {
				activeUsers: activeUsersSet.size,
				totalUsers: Number(totalUsers || 0),
				totalSurveys: Number(totalSurveyBinary || 0) + Number(totalSurveyMultiple || 0),
				totalResponses:
					Number(totalOpinionsBinary || 0) + Number(totalOpinionsMultiple || 0),
			},
			series: {
				labels: monthlySeries.map((item) => item.label),
				activeUsers: monthlySeries.map((item) => item.activeUsers),
				surveysCreated: monthlySeries.map((item) => item.surveysCreated),
			},
		});
	} catch (error) {
		console.error('public.getPlatformMetrics:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
