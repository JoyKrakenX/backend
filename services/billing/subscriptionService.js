/** @format */

const Subscription = require('../../models/Subscription');
const { TRIAL_SETTINGS, SUBSCRIPTION_STATUSES, PLAN_CODES } = require('./constants');
const { addDaysUtc, addMonthsUtc } = require('./periodService');
const { getPlanByCode, isPaidPlan } = require('./planService');

const isWritableSubscriptionStatus = (status) =>
	[
		SUBSCRIPTION_STATUSES.TRIALING,
		SUBSCRIPTION_STATUSES.ACTIVE,
		SUBSCRIPTION_STATUSES.PAST_DUE,
	].includes(String(status || ''));

const isReadOnlySubscriptionStatus = (status) =>
	[String(status || '')].includes(SUBSCRIPTION_STATUSES.SUSPENDED);

const getEffectivePlanCode = (subscription) => {
	if (!subscription) return null;
	if (
		String(subscription.status || '') === SUBSCRIPTION_STATUSES.TRIALING &&
		subscription.trialPlanCode
	) {
		return String(subscription.trialPlanCode).trim().toUpperCase();
	}
	return String(subscription.planCode || '').trim().toUpperCase() || null;
};

const createFreeTrialSubscriptionInput = (organizationId, now = new Date()) => {
	const periodEndAt = addMonthsUtc(now, 1);
	return {
		organizationId,
		planCode: TRIAL_SETTINGS.basePlanCode,
		trialPlanCode: TRIAL_SETTINGS.trialPlanCode,
		status: SUBSCRIPTION_STATUSES.TRIALING,
		trialStartedAt: now,
		trialEndsAt: addDaysUtc(now, TRIAL_SETTINGS.durationDays),
		graceEndsAt: null,
		currentPeriodStartAt: now,
		currentPeriodEndAt: periodEndAt,
		nextBillingAt: periodEndAt,
		lastPaidAt: null,
		readOnlySince: null,
	};
};

const ensureDefaultSubscription = async (organizationId, now = new Date()) => {
	let subscription = await Subscription.findOne({ organizationId });
	if (subscription) return subscription;

	subscription = await Subscription.create(
		createFreeTrialSubscriptionInput(organizationId, now),
	);
	return subscription;
};

const rollFreePlanCycle = (subscription, now) => {
	subscription.status = SUBSCRIPTION_STATUSES.ACTIVE;
	subscription.readOnlySince = null;
	subscription.graceEndsAt = null;
	subscription.currentPeriodStartAt = now;
	subscription.currentPeriodEndAt = addMonthsUtc(now, 1);
	subscription.nextBillingAt = subscription.currentPeriodEndAt;
};

const applyLifecycleTransitions = async (subscription, now = new Date()) => {
	if (!subscription) return null;
	const next = subscription;

	if (String(next.status || '') === SUBSCRIPTION_STATUSES.GRACE) {
		next.status = SUBSCRIPTION_STATUSES.PAST_DUE;
	}

	if (
		next.status === SUBSCRIPTION_STATUSES.TRIALING &&
		next.trialEndsAt &&
		new Date(next.trialEndsAt).getTime() <= now.getTime()
	) {
		next.status = SUBSCRIPTION_STATUSES.ACTIVE;
		next.trialPlanCode = null;
		next.trialStartedAt = null;
		next.trialEndsAt = null;
		next.graceEndsAt = null;
		next.readOnlySince = null;
		next.currentPeriodStartAt = now;
		next.currentPeriodEndAt = addMonthsUtc(now, 1);
		next.nextBillingAt = next.currentPeriodEndAt;
	}

	const basePlanCode = String(next.planCode || '').trim().toUpperCase();
	const basePlan = basePlanCode ? await getPlanByCode(basePlanCode) : null;
	const isFreePlan = basePlanCode === PLAN_CODES.FREE;
	const requiresPayment = basePlan ? isPaidPlan(basePlan) : false;

	if (
		next.status === SUBSCRIPTION_STATUSES.ACTIVE &&
		next.currentPeriodEndAt &&
		new Date(next.currentPeriodEndAt).getTime() <= now.getTime()
	) {
		if (!requiresPayment || isFreePlan) {
			rollFreePlanCycle(next, now);
		} else {
			next.status = SUBSCRIPTION_STATUSES.PAST_DUE;
			next.graceEndsAt = addDaysUtc(now, TRIAL_SETTINGS.paymentGraceDays);
		}
	}

	if (
		next.status === SUBSCRIPTION_STATUSES.PAST_DUE &&
		next.graceEndsAt &&
		new Date(next.graceEndsAt).getTime() <= now.getTime()
	) {
		next.status = SUBSCRIPTION_STATUSES.SUSPENDED;
		next.readOnlySince = now;
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
	getEffectivePlanCode,
	createFreeTrialSubscriptionInput,
};
