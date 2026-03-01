/** @format */

const Subscription = require('../../models/Subscription');
const { TRIAL_SETTINGS, SUBSCRIPTION_STATUSES } = require('./constants');
const { addDaysUtc, addMonthsUtc } = require('./periodService');

const isWritableSubscriptionStatus = (status) =>
	[
		SUBSCRIPTION_STATUSES.TRIALING,
		SUBSCRIPTION_STATUSES.ACTIVE,
		SUBSCRIPTION_STATUSES.GRACE,
		SUBSCRIPTION_STATUSES.PAST_DUE,
	].includes(String(status || ''));

const isReadOnlySubscriptionStatus = (status) =>
	[String(status || '')].includes(SUBSCRIPTION_STATUSES.SUSPENDED);

const ensureDefaultSubscription = async (organizationId, now = new Date()) => {
	let subscription = await Subscription.findOne({ organizationId });
	if (subscription) return subscription;

	const trialEndsAt = addDaysUtc(now, TRIAL_SETTINGS.durationDays);
	const periodEndAt = addMonthsUtc(now, 1);
	subscription = await Subscription.create({
		organizationId,
		planCode: TRIAL_SETTINGS.planCode,
		status: SUBSCRIPTION_STATUSES.TRIALING,
		trialStartedAt: now,
		trialEndsAt,
		currentPeriodStartAt: now,
		currentPeriodEndAt: periodEndAt,
		nextBillingAt: periodEndAt,
	});

	return subscription;
};

const applyLifecycleTransitions = async (subscription, now = new Date()) => {
	if (!subscription) return null;
	const next = subscription;

	if (
		next.status === SUBSCRIPTION_STATUSES.TRIALING &&
		next.trialEndsAt &&
		new Date(next.trialEndsAt).getTime() < now.getTime()
	) {
		next.status = SUBSCRIPTION_STATUSES.GRACE;
		next.graceEndsAt = addDaysUtc(next.trialEndsAt, TRIAL_SETTINGS.graceDays);
	}

	if (
		(next.status === SUBSCRIPTION_STATUSES.GRACE ||
			next.status === SUBSCRIPTION_STATUSES.PAST_DUE) &&
		next.graceEndsAt &&
		new Date(next.graceEndsAt).getTime() < now.getTime()
	) {
		next.status = SUBSCRIPTION_STATUSES.SUSPENDED;
		next.readOnlySince = now;
	}

	if (
		next.status === SUBSCRIPTION_STATUSES.ACTIVE &&
		next.currentPeriodEndAt &&
		new Date(next.currentPeriodEndAt).getTime() < now.getTime()
	) {
		next.status = SUBSCRIPTION_STATUSES.PAST_DUE;
		next.graceEndsAt = addDaysUtc(now, TRIAL_SETTINGS.graceDays);
	}

	if (next.isModified()) {
		await next.save();
	}
	return next;
};

const getOrganizationSubscription = async (organizationId, now = new Date()) => {
	const subscription = await ensureDefaultSubscription(organizationId, now);
	return applyLifecycleTransitions(subscription, now);
};

module.exports = {
	getOrganizationSubscription,
	ensureDefaultSubscription,
	applyLifecycleTransitions,
	isWritableSubscriptionStatus,
	isReadOnlySubscriptionStatus,
};
