/** @format */

const { z } = require('zod');

const Invoice = require('../models/Invoice');
const PaymentEvent = require('../models/PaymentEvent');
const { getPublicPlans, getPlanByCode } = require('../services/billing/planService');
const { getOrganizationSubscription } = require('../services/billing/subscriptionService');
const { getMonthlyUsage } = require('../services/billing/usageService');
const { countOrganizationAdmins, calculateOverage } = require('../services/billing/invoiceService');
const { createFxQuote, normalizeQuoteCurrency } = require('../services/billing/fxService');
const { retrieveTransaction, verifyWebhookSignature, isConfigured: isFedaPayConfigured } = require('../services/billing/fedapayService');
const { getPeriodKeyUtc } = require('../services/billing/periodService');
const { normalizeQuota } = require('../services/billing/quotaUtils');
const {
	findOrCreateInvoiceForOperation,
	resolveBillingContact,
	attemptAutoRenewalCharge,
	validateVerifiedTransactionAgainstInvoice,
	markInvoicePaidAndActivateSubscription,
	markInvoiceFailedAndPastDue,
} = require('../services/billing/paymentOrchestratorService');
const { logSecurityEvent } = require('../services/securityAuditService');
const {
	COMMERCIAL_RULES,
	ENTERPRISE_TEASER,
	SUBSCRIPTION_STATUSES,
} = require('../services/billing/constants');
const { isBillingExemptEmail } = require('../services/superAdminService');

const TRIALING_CHECKOUT_LOCK_MESSAGE =
	"Essai gratuit en cours: la facturation est verrouillee jusqu'a la fin de l'essai.";

const BILLING_ERROR_CODES = Object.freeze({
	TRIALING_LOCKED: 'BILLING_TRIALING_LOCKED',
	PROVIDER_AMOUNT_CAP: 'BILLING_PROVIDER_AMOUNT_CAP',
	PROVIDER_UNAVAILABLE: 'BILLING_PROVIDER_UNAVAILABLE',
	CHECKOUT_INIT_FAILED: 'BILLING_CHECKOUT_INIT_FAILED',
});

const BILLING_ERROR_MESSAGES = Object.freeze({
	[BILLING_ERROR_CODES.TRIALING_LOCKED]: TRIALING_CHECKOUT_LOCK_MESSAGE,
	[BILLING_ERROR_CODES.PROVIDER_AMOUNT_CAP]:
		'Le montant depasse le plafond autorise par le fournisseur de paiement.',
	[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE]:
		'Service de paiement indisponible. Reessayez plus tard.',
	[BILLING_ERROR_CODES.CHECKOUT_INIT_FAILED]: 'Impossible de lancer le checkout.',
});

const BILLING_ERROR_STATUS_BY_CODE = Object.freeze({
	[BILLING_ERROR_CODES.TRIALING_LOCKED]: 409,
	[BILLING_ERROR_CODES.PROVIDER_AMOUNT_CAP]: 422,
	[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE]: 503,
	[BILLING_ERROR_CODES.CHECKOUT_INIT_FAILED]: 500,
});

const PROVIDER_AMOUNT_CAP_PATTERN =
	/montant maximum|maximum amount|max(?:imum)?(?:\s+de)?\s+transactions?/i;

const isKnownBillingErrorCode = (code) =>
	Object.values(BILLING_ERROR_CODES).includes(String(code || '').trim());

const buildTrialingCheckoutError = (subscription = null) => ({
	status: BILLING_ERROR_STATUS_BY_CODE[BILLING_ERROR_CODES.TRIALING_LOCKED],
	body: {
		message: BILLING_ERROR_MESSAGES[BILLING_ERROR_CODES.TRIALING_LOCKED],
		code: BILLING_ERROR_CODES.TRIALING_LOCKED,
		details: {
			subscriptionStatus: SUBSCRIPTION_STATUSES.TRIALING,
			trialEndsAt: subscription?.trialEndsAt || null,
		},
	},
});

const normalizeCheckoutError = (error) => {
	const details =
		error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
			? error.details
			: null;
	const rawCode = String(error?.code || '').trim();
	const rawMessage = String(error?.message || '').trim();

	let code = BILLING_ERROR_CODES.CHECKOUT_INIT_FAILED;
	if (isKnownBillingErrorCode(rawCode)) {
		code = rawCode;
	} else if (PROVIDER_AMOUNT_CAP_PATTERN.test(rawMessage)) {
		code = BILLING_ERROR_CODES.PROVIDER_AMOUNT_CAP;
	} else if (
		/FedaPay non configure|Open Exchange Rates non configure|Taux FX indisponible/i.test(
			rawMessage,
		)
	) {
		code = BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE;
	} else if (/essai gratuit en cours|free trial/i.test(rawMessage)) {
		code = BILLING_ERROR_CODES.TRIALING_LOCKED;
	}

	const status = BILLING_ERROR_STATUS_BY_CODE[code] || 500;

	const body = {
		message: BILLING_ERROR_MESSAGES[code] || BILLING_ERROR_MESSAGES[BILLING_ERROR_CODES.CHECKOUT_INIT_FAILED],
		code,
	};
	if (details) {
		body.details = details;
	}
	return { status, body };
};

const checkoutSchema = z.object({
	planCode: z.string().trim().min(1).max(80).optional(),
	mode: z.enum(['upgrade', 'renewal', 'retry']).optional(),
	organizationId: z.string().trim().min(1).optional(),
	savePaymentMethod: z.boolean().optional(),
});

const retrySchema = z.object({
	invoiceId: z.string().trim().min(1).optional(),
	organizationId: z.string().trim().min(1).optional(),
	savePaymentMethod: z.boolean().optional(),
});

const toMoney = (value) =>
	Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const buildMetrics = ({ plan, usage, adminsCount }) => {
	const counts = usage?.counts || {};
	const quotas = plan?.quotas || {};

	const metrics = [
		{
			key: 'votes',
			label: 'Votes',
			consumed: Number(counts.votes || 0),
			quota: quotas.votes ?? null,
		},
		{
			key: 'surveys',
			label: 'Sondages',
			consumed: Number(counts.surveys || 0),
			quota: quotas.surveys ?? null,
		},
		{
			key: 'exports',
			label: 'Exports',
			consumed: Number(counts.exports || 0),
			quota: quotas.exports ?? null,
		},
		{
			key: 'chatConcurrent',
			label: 'Simultane chatroom',
			consumed: Number(usage?.chatPeakMax || 0),
			quota: quotas.chatConcurrent ?? null,
		},
		{
			key: 'admins',
			label: 'Admins',
			consumed: Number(adminsCount || 0),
			quota: quotas.admins ?? null,
		},
	].map((metric) => {
		const finiteQuota = normalizeQuota(metric.quota);
		const percent =
			finiteQuota === null || finiteQuota <= 0 ?
				null
			: 	Math.min(100, Math.round((metric.consumed / finiteQuota) * 100));
		let alertLevel = null;
		if (percent !== null) {
			if (percent >= 100) alertLevel = 100;
			else if (percent >= 90) alertLevel = 90;
			else if (percent >= 70) alertLevel = 70;
		}
		return {
			...metric,
			quota: finiteQuota,
			percent,
			alertLevel,
		};
	});

	return metrics;
};

exports.__test = {
	buildMetrics,
};

const buildPaymentInstrumentPayload = (subscription) => ({
	canAutoCharge: Boolean(subscription?.provider?.canAutoCharge),
	paymentMethodType: subscription?.provider?.paymentMethodType || null,
	last4: subscription?.provider?.last4 || null,
	expMonth: subscription?.provider?.expMonth || null,
	expYear: subscription?.provider?.expYear || null,
});

const buildCheckoutResponse = (invoice, checkoutData, mode, paymentInstrument = null) => ({
	invoiceId: String(invoice._id),
	provider: 'fedapay',
	txRef: invoice.provider?.txRef || null,
	checkoutLink: checkoutData?.link || invoice.provider?.checkoutLink || null,
	invoicePlanCode: invoice.planCode || null,
	targetPlanCode: invoice?.metadata?.targetPlanCode || null,
	amountUsd: toMoney(invoice.totalAmountUsd),
	chargeAmount: Number(invoice?.charge?.amount || 0),
	chargeCurrency: invoice?.charge?.currency || invoice?.fx?.quoteCurrency || 'XOF',
	fxRate: Number(invoice?.fx?.rate || 0) || null,
	fxSource: invoice?.fx?.source || null,
	fxAsOf: invoice?.fx?.asOf || null,
	fxLockedAt: invoice?.fx?.lockedAt || null,
	fxLockExpiresAt: invoice?.fx?.lockExpiresAt || null,
	currency: invoice.currency || 'USD',
	status: invoice.status,
	chargeMode: invoice.provider?.chargeMode || null,
	mode,
	paymentInstrument,
});

const normalizeWebhookEvent = (payload = {}) => {
	const eventType = String(
		payload?.event || payload?.name || payload?.type || payload?.event_type || 'unknown',
	).trim();
	const providerEventId =
		String(payload?.id || payload?.event_id || payload?.data?.id || payload?.entity?.id || '')
			.trim() || null;
	const transactionId =
		String(
			payload?.data?.id ||
				payload?.transaction?.id ||
				payload?.entity?.id ||
				payload?.object?.id ||
				'',
		).trim() || null;
	const reference =
		String(
			payload?.data?.reference ||
				payload?.data?.merchant_reference ||
				payload?.transaction?.reference ||
				payload?.entity?.reference ||
				'',
		).trim() || null;

	return {
		eventType,
		providerEventId,
		transactionId,
		reference,
	};
};

const settlePendingInvoiceFromTransaction = async ({ invoice, transaction, trigger = 'poll' }) => {
	if (!invoice || !transaction) {
		return { settled: false, status: 'missing' };
	}

	const validation = validateVerifiedTransactionAgainstInvoice({
		invoice,
		verification: transaction,
		expectedReference: invoice?.provider?.txRef || null,
		organizationId: invoice.organizationId,
	});

	if (!validation.ok) {
		await logSecurityEvent({
			event: 'billing_transaction_verification_failed',
			level: 'warning',
			action: trigger,
			code: validation.code,
			message: validation.message,
			organizationId: invoice.organizationId,
			meta: {
				invoiceId: String(invoice._id),
				providerTransactionId: String(transaction?.id || ''),
			},
		});

		await markInvoiceFailedAndPastDue({
			invoice,
			rawStatus: String(transaction?.status || 'failed'),
			transactionId: String(transaction?.id || invoice?.provider?.transactionId || ''),
			reason: validation,
		});
		return { settled: true, status: 'failed' };
	}

	await markInvoicePaidAndActivateSubscription({
		invoice,
		verification: transaction,
		transactionId: String(transaction?.id || invoice?.provider?.transactionId || ''),
		rawStatus: String(transaction?.status || 'approved'),
		targetPlanCode: invoice?.metadata?.targetPlanCode || null,
		chargeMode: 'checkout',
	});
	return { settled: true, status: 'paid' };
};

exports.getPlans = async (_req, res) => {
	try {
		const plans = await getPublicPlans();
		return res.status(200).json({
			currency: 'USD',
			plans,
			enterpriseTeaser: ENTERPRISE_TEASER,
			commercialRules: COMMERCIAL_RULES,
		});
	} catch (error) {
		console.error('billing.getPlans:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.getSummary = async (req, res) => {
	try {
		const organization = req.activeOrganization;
		const billingExempt =
			isBillingExemptEmail(req.userEmail || req.user?.email) &&
			String(organization?.ownerUserId || '') === String(req.userId || '');
		const subscription = await getOrganizationSubscription(organization._id);
		const plan = await getPlanByCode(subscription.planCode);
		const usage =
			(await getMonthlyUsage(organization._id)) || {
				counts: { votes: 0, surveys: 0, exports: 0 },
				chatPeakMax: 0,
				adminsPeak: 1,
			};
		const adminsCount = await countOrganizationAdmins(organization._id);
		const metrics = buildMetrics({ plan, usage, adminsCount });
		const overageEstimate = calculateOverage({ plan, usage, adminsCount });

		const paymentCurrency = normalizeQuoteCurrency(
			organization?.paymentCurrency || organization?.currency || 'XOF',
		);
		const totalEstimateUsd = toMoney(Number(plan?.priceMonthlyUsd || 0) + Number(overageEstimate?.totalUsd || 0));
		let billingQuotePreview = {
			baseCurrency: 'USD',
			paymentCurrency,
			amountUsd: totalEstimateUsd,
			chargeAmount: null,
			rate: null,
			source: null,
			asOf: null,
			available: false,
		};
		try {
			const quote = await createFxQuote({
				amountUsd: totalEstimateUsd,
				quoteCurrency: paymentCurrency,
			});
			billingQuotePreview = {
				baseCurrency: 'USD',
				paymentCurrency: quote.currency,
				amountUsd: quote.amountUsd,
				chargeAmount: quote.chargeAmount,
				rate: quote.rate,
				source: quote.source,
				asOf: quote.asOf,
				available: true,
			};
		} catch (_error) {
			billingQuotePreview.error = 'FX_UNAVAILABLE';
		}

		return res.status(200).json({
			organization: {
				_id: organization._id,
				name: organization.name,
				status: organization.status,
				timezone: organization.timezone,
				currency: organization.currency || 'USD',
				paymentCurrency,
			},
			entitlement: {
				billingExempt,
				billingExemptScope: billingExempt ? 'owner_only' : null,
			},
			subscription: {
				_id: subscription._id,
				status: subscription.status,
				planCode: subscription.planCode,
				trialEndsAt: subscription.trialEndsAt,
				graceEndsAt: subscription.graceEndsAt,
				currentPeriodStartAt: subscription.currentPeriodStartAt,
				currentPeriodEndAt: subscription.currentPeriodEndAt,
				nextBillingAt: subscription.nextBillingAt,
				paymentInstrument: buildPaymentInstrumentPayload(subscription),
			},
			plan,
			usage: {
				periodKey: usage.periodKey || getPeriodKeyUtc(new Date()),
				counts: usage.counts || { votes: 0, surveys: 0, exports: 0 },
				chatPeakMax: Number(usage.chatPeakMax || 0),
				adminsPeak: Number(usage.adminsPeak || adminsCount || 1),
				adminsCurrent: adminsCount,
				metrics,
			},
			overageEstimate,
			billingQuotePreview,
		});
	} catch (error) {
		console.error('billing.getSummary:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.getInvoices = async (req, res) => {
	try {
		const invoices = await Invoice.find({ organizationId: req.activeOrganizationId })
			.sort({ createdAt: -1 })
			.limit(80)
			.lean();
		return res.status(200).json(invoices);
	} catch (error) {
		console.error('billing.getInvoices:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.createCheckout = async (req, res) => {
	try {
		if (!isFedaPayConfigured()) {
			return res.status(BILLING_ERROR_STATUS_BY_CODE[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE]).json({
				message: BILLING_ERROR_MESSAGES[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE],
				code: BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE,
				details: { reason: 'FEDAPAY_NOT_CONFIGURED' },
			});
		}

		const parsed = checkoutSchema.safeParse(req.body || {});
		if (!parsed.success) {
			return res.status(400).json({
				message: 'Payload checkout invalide.',
				errors: parsed.error.flatten(),
			});
		}

		const requestedMode = parsed.data.mode || 'renewal';
		const subscription = await getOrganizationSubscription(req.activeOrganizationId);
		if (
			String(subscription?.status || '').trim().toLowerCase() ===
			SUBSCRIPTION_STATUSES.TRIALING
		) {
			const trialingError = buildTrialingCheckoutError(subscription);
			return res.status(trialingError.status).json(trialingError.body);
		}
		const targetPlanCode = parsed.data.planCode
			? String(parsed.data.planCode).trim().toUpperCase()
			: subscription.planCode;
		let mode = requestedMode;
		if (requestedMode !== 'retry' && targetPlanCode !== String(subscription.planCode || '')) {
			mode = 'upgrade';
		} else if (
			requestedMode === 'upgrade' &&
			targetPlanCode === String(subscription.planCode || '')
		) {
			mode = 'renewal';
		}
		const billingPlan = await getPlanByCode(subscription.planCode);
		const targetPlan = await getPlanByCode(targetPlanCode);
		if (!billingPlan || !targetPlan) {
			return res.status(400).json({ message: 'Plan de facturation introuvable.' });
		}
		if (
			mode === 'upgrade' &&
			(!targetPlan?.isPublic || !Number.isFinite(Number(targetPlan?.priceMonthlyUsd)))
		) {
			return res.status(400).json({
				message:
					'Ce plan ne peut pas etre active en libre-service. Contactez le support commercial.',
			});
		}

		const invoicePlan = mode === 'upgrade' ? targetPlan : billingPlan;

		const usage = await getMonthlyUsage(req.activeOrganizationId);
		const invoice = await findOrCreateInvoiceForOperation({
			organizationId: req.activeOrganizationId,
			subscription,
			plan: invoicePlan,
			usage,
			mode,
			targetPlanCode: targetPlanCode && targetPlanCode !== subscription.planCode ? targetPlanCode : null,
		});

		const contact = await resolveBillingContact({
			organizationId: req.activeOrganizationId,
			fallbackEmail: req.userEmail || req.user?.email,
			fallbackName: req.userPseudo || req.user?.pseudo || req.activeOrganization?.name,
		});

		const paymentResult = await attemptAutoRenewalCharge({
			subscription,
			invoice,
			customerEmail: contact.email,
			customerName: contact.name,
			organizationId: req.activeOrganizationId,
			mode,
		});

		const refreshedSubscription = await getOrganizationSubscription(req.activeOrganizationId);
		return res.status(200).json(
			buildCheckoutResponse(
				paymentResult.invoice || invoice,
				paymentResult.checkoutData || null,
				mode,
				buildPaymentInstrumentPayload(refreshedSubscription),
			),
		);
	} catch (error) {
		console.error('billing.createCheckout:', error);
		const normalized = normalizeCheckoutError(error);
		return res.status(normalized.status).json(normalized.body);
	}
};

exports.retryPayment = async (req, res) => {
	try {
		if (!isFedaPayConfigured()) {
			return res.status(BILLING_ERROR_STATUS_BY_CODE[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE]).json({
				message: BILLING_ERROR_MESSAGES[BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE],
				code: BILLING_ERROR_CODES.PROVIDER_UNAVAILABLE,
				details: { reason: 'FEDAPAY_NOT_CONFIGURED' },
			});
		}
		const parsed = retrySchema.safeParse(req.body || {});
		if (!parsed.success) {
			return res.status(400).json({
				message: 'Payload retry invalide.',
				errors: parsed.error.flatten(),
			});
		}

		const subscription = await getOrganizationSubscription(req.activeOrganizationId);
		if (
			String(subscription?.status || '').trim().toLowerCase() ===
			SUBSCRIPTION_STATUSES.TRIALING
		) {
			const trialingError = buildTrialingCheckoutError(subscription);
			return res.status(trialingError.status).json(trialingError.body);
		}

		const invoice = parsed.data.invoiceId
			? await Invoice.findOne({
					_id: parsed.data.invoiceId,
					organizationId: req.activeOrganizationId,
			  })
			: await Invoice.findOne({
					organizationId: req.activeOrganizationId,
					status: { $in: ['failed', 'pending'] },
			  }).sort({ createdAt: -1 });

		if (!invoice) {
			return res.status(404).json({ message: 'Aucune facture a relancer.' });
		}

		const contact = await resolveBillingContact({
			organizationId: req.activeOrganizationId,
			fallbackEmail: req.userEmail || req.user?.email,
			fallbackName: req.userPseudo || req.user?.pseudo || req.activeOrganization?.name,
		});

		const paymentResult = await attemptAutoRenewalCharge({
			subscription,
			invoice,
			customerEmail: contact.email,
			customerName: contact.name,
			organizationId: req.activeOrganizationId,
			mode: 'retry',
		});

		const refreshedSubscription = await getOrganizationSubscription(req.activeOrganizationId);
		return res.status(200).json(
			buildCheckoutResponse(
				paymentResult.invoice || invoice,
				paymentResult.checkoutData || null,
				'retry',
				buildPaymentInstrumentPayload(refreshedSubscription),
			),
		);
	} catch (error) {
		console.error('billing.retryPayment:', error);
		const normalized = normalizeCheckoutError(error);
		return res.status(normalized.status).json(normalized.body);
	}
};

exports.getCheckoutStatus = async (req, res) => {
	try {
		const invoiceId = String(req.params.invoiceId || '').trim();
		if (!invoiceId) {
			return res.status(400).json({ message: 'invoiceId manquant.' });
		}

		const invoice = await Invoice.findOne({
			_id: invoiceId,
			organizationId: req.activeOrganizationId,
		});
		if (!invoice) {
			return res.status(404).json({ message: 'Facture introuvable.' });
		}

		if (String(invoice.status).toLowerCase() === 'pending' && invoice?.provider?.transactionId) {
			try {
				const transaction = await retrieveTransaction(invoice.provider.transactionId);
				const txStatus = String(transaction?.status || '').trim().toLowerCase();
				if (['approved', 'successful', 'paid'].includes(txStatus)) {
					await settlePendingInvoiceFromTransaction({
						invoice,
						transaction,
						trigger: 'checkout_status_poll',
					});
				} else if (['declined', 'failed', 'canceled', 'cancelled', 'expired'].includes(txStatus)) {
					await markInvoiceFailedAndPastDue({
						invoice,
						rawStatus: txStatus,
						transactionId: String(transaction?.id || invoice?.provider?.transactionId || ''),
						reason: {
							code: 'TX_STATUS_FAILED',
							message: 'Paiement refuse ou annule.',
						},
					});
				}
			} catch (error) {
				await logSecurityEvent({
					event: 'billing_checkout_status_poll_error',
					level: 'warning',
					action: 'checkout_status_poll',
					code: 'POLL_ERROR',
					message: error?.message || 'Erreur lors du polling transaction.',
					organizationId: invoice.organizationId,
					meta: {
						invoiceId: String(invoice._id),
						transactionId: String(invoice?.provider?.transactionId || ''),
					},
				});
			}
		}

		const refreshed = await Invoice.findById(invoice._id).lean();
		return res.status(200).json({
			invoiceId: String(refreshed?._id || invoice._id),
			status: refreshed?.status || invoice.status,
			providerStatus: refreshed?.provider?.rawStatus || null,
			checkoutLink: refreshed?.provider?.checkoutLink || null,
			paidAt: refreshed?.paidAt || null,
			chargeAmount: Number(refreshed?.charge?.amount || 0),
			chargeCurrency: refreshed?.charge?.currency || refreshed?.fx?.quoteCurrency || 'XOF',
		});
	} catch (error) {
		console.error('billing.getCheckoutStatus:', error);
		return res.status(500).json({ message: 'Etat checkout indisponible.' });
	}
};

exports.fedapayWebhook = async (req, res) => {
	try {
		const signatureValid = verifyWebhookSignature(req);
		if (!signatureValid) {
			await logSecurityEvent({
				event: 'billing_webhook_invalid_signature',
				level: 'warning',
				action: 'fedapay_webhook',
				code: 'INVALID_SIGNATURE',
				message: 'Signature webhook FedaPay invalide.',
				ip: req?.ip || null,
				userAgent: req?.headers?.['user-agent'] || null,
			});
			return res.status(401).json({ message: 'Signature webhook invalide.' });
		}

		const payload = req.body || {};
		const normalized = normalizeWebhookEvent(payload);
		const stableEventId =
			normalized.providerEventId ||
			`fedapay:${String(normalized.transactionId || normalized.reference || 'unknown')}:${String(normalized.eventType || 'event')}`;

		let paymentEvent;
		try {
			paymentEvent = await PaymentEvent.create({
				provider: 'fedapay',
				eventId: stableEventId,
				providerEventId: normalized.providerEventId || null,
				eventType: normalized.eventType,
				txRef: normalized.reference || null,
				signatureValid: true,
				status: 'received',
				payload,
			});
		} catch (error) {
			if (error?.code === 11000) {
				return res.status(200).json({ ok: true, duplicate: true });
			}
			throw error;
		}

		const invoice =
			(await Invoice.findOne({ 'provider.transactionId': normalized.transactionId })) ||
			(await Invoice.findOne({ 'provider.txRef': normalized.reference }));
		if (!invoice) {
			paymentEvent.status = 'ignored';
			paymentEvent.processedAt = new Date();
			await paymentEvent.save();
			return res.status(200).json({ ok: true, ignored: true });
		}

		if (String(invoice.status || '').toLowerCase() === 'paid') {
			paymentEvent.status = 'processed';
			paymentEvent.processedAt = new Date();
			await paymentEvent.save();
			return res.status(200).json({ ok: true, status: 'already_paid' });
		}

		const transactionId = normalized.transactionId || String(invoice?.provider?.transactionId || '');
		if (!transactionId) {
			paymentEvent.status = 'ignored';
			paymentEvent.processedAt = new Date();
			await paymentEvent.save();
			return res.status(200).json({ ok: true, ignored: true });
		}

		const verification = await retrieveTransaction(transactionId);
		const txStatus = String(verification?.status || '').trim().toLowerCase();
		if (['declined', 'failed', 'canceled', 'cancelled', 'expired'].includes(txStatus)) {
			await markInvoiceFailedAndPastDue({
				invoice,
				rawStatus: txStatus,
				transactionId,
				reason: {
					code: 'TX_STATUS_FAILED',
					message: 'Paiement refuse ou annule.',
				},
			});
			paymentEvent.status = 'failed';
			paymentEvent.processedAt = new Date();
			await paymentEvent.save();
			return res.status(200).json({ ok: true, status: 'failed' });
		}

		const settlement = await settlePendingInvoiceFromTransaction({
			invoice,
			transaction: verification,
			trigger: 'fedapay_webhook',
		});

		paymentEvent.status = settlement.status === 'paid' ? 'processed' : 'failed';
		paymentEvent.processedAt = new Date();
		await paymentEvent.save();
		return res.status(200).json({ ok: true, status: settlement.status });
	} catch (error) {
		console.error('billing.fedapayWebhook:', error);
		return res.status(500).json({ message: 'Webhook processing error.' });
	}
};
