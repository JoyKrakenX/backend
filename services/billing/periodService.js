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

const formatDateKeyUtc = (value) => {
	const date = toDate(value);
	const year = date.getUTCFullYear();
	const month = String(date.getUTCMonth() + 1).padStart(2, '0');
	const day = String(date.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
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

const buildBillingCycleKey = ({ startAt, endAt }) => {
	const start = toDate(startAt);
	const end = toDate(endAt);
	return `cycle:${formatDateKeyUtc(start)}:${formatDateKeyUtc(end)}`;
};

const buildUsageWindowDescriptor = ({
	subscription = null,
	date = new Date(),
	forceCalendarMonth = false,
} = {}) => {
	const at = toDate(date);

	if (!forceCalendarMonth) {
		const startAt = subscription?.currentPeriodStartAt
			? toDate(subscription.currentPeriodStartAt)
			: null;
		const endAt = subscription?.currentPeriodEndAt
			? toDate(subscription.currentPeriodEndAt)
			: null;
		if (startAt && endAt && endAt.getTime() > startAt.getTime()) {
			return {
				periodType: 'billing_cycle',
				periodStartAt: startAt,
				periodEndAt: endAt,
				periodKey: buildBillingCycleKey({ startAt, endAt }),
			};
		}
	}

	const periodStartAt = getUtcMonthStart(at);
	const periodEndAt = addMonthsUtc(periodStartAt, 1);
	return {
		periodType: 'calendar_month',
		periodStartAt,
		periodEndAt,
		periodKey: getPeriodKeyUtc(at),
	};
};

module.exports = {
	toDate,
	getUtcMonthStart,
	getPeriodKeyUtc,
	formatDateKeyUtc,
	addMonthsUtc,
	addDaysUtc,
	buildBillingCycleKey,
	buildUsageWindowDescriptor,
};
