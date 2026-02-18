/** @format */

const DEFAULT_SUPPORT_TIMEZONE = 'Africa/Porto-Novo';

const toTimezoneParts = (timeZone) => {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hour12: false,
		weekday: 'short',
		hour: '2-digit',
	});

	const parts = formatter.formatToParts(new Date());
	const partMap = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	const weekdayMap = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};

	return {
		day: weekdayMap[partMap.weekday] ?? 0,
		hour: Number(partMap.hour || 0),
	};
};

const isSupportBusinessHours = () => {
	const configuredTimeZone = process.env.SUPPORT_TIMEZONE || DEFAULT_SUPPORT_TIMEZONE;
	try {
		const { day, hour } = toTimezoneParts(configuredTimeZone);
		return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
	} catch (_error) {
		const { day, hour } = toTimezoneParts(DEFAULT_SUPPORT_TIMEZONE);
		return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
	}
};

module.exports = {
	isSupportBusinessHours,
};
