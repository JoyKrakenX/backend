/** @format */

const toDate = (value) => {
	const date = value ? new Date(value) : new Date();
	return Number.isNaN(date.getTime()) ? new Date() : date;
};

const getUtcMonthStart = (value) => {
	const date = toDate(value);
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
};

const getPeriodKeyUtc = (value) => {
	const date = toDate(value);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	return `${year}-${month}`;
};

const addMonthsUtc = (value, delta) => {
	const date = toDate(value);
	return new Date(
		Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth() + Number(delta || 0),
			date.getUTCDate(),
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds(),
			date.getUTCMilliseconds(),
		),
	);
};

const addDaysUtc = (value, delta) => {
	const date = toDate(value);
	return new Date(date.getTime() + Number(delta || 0) * 24 * 60 * 60 * 1000);
};

module.exports = {
	getUtcMonthStart,
	getPeriodKeyUtc,
	addMonthsUtc,
	addDaysUtc,
};
