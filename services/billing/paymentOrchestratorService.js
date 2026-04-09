/** @format */

const crypto = require('crypto');

const Invoice = require('../../models/Invoice');
const Subscription = require('../../models/Subscription');
const Organization = require('../../models/Organization');
const User = require('../../models/User');
const { TRIAL_SETTINGS, SUBSCRIPTION_STATUSES } = require('./constants');
const { addDaysUtc, addMonthsUtc, getPeriodKeyUtc } = require('./periodService');
const { buildInvoiceDraft, buildInvoiceKey } = require('./invoiceService');
const { createTransaction, generateCheckoutToken } = require('./fedapayService');
const { buildFxLock, isFxLockExpired, normalizeQuoteCurrency } = require('./fxService');
const { logSecurityEvent } = require('../securityAuditService');

const toMoney = (value) =>
	Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const BILLING_ERROR_CODES = Object.freeze({
	TRIALING_LOCKED: 'BILLING_TRIALING_LOCKED',
	PROVIDER_AMOUNT_CAP: 'BILLING_PROVIDER_AMOUNT_CAP',
});

const createBillingError = ({ code, message, status = 500, details = null }) => {
	const error = new Error(String(message || 'Billing error.'));
	error.code = String(code || 'BILLING_CHECKOUT_INIT_FAILED');
	error.status = Number(status || 500);
	if (details && typeof details === 'object') {
		error.details = details;
	}
	return error;
};

const getFedaPayMaxAmountXof = () => {
	const raw = String(process.env.FEDAPAY_MAX_AMOUNT_XOF || '').trim();
	if (!raw) return null;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) return null;
	return value;
};

const assertProviderAmountCap = ({ chargeAmount, chargeCurrency }) => {
	const currency = String(chargeCurrency || '').trim().toUpperCase();
	if (currency !== 'XOF') return;
	const providerMaxAmount = getFedaPayMaxAmountXof();
	if (!providerMaxAmount) return;
	const amount = Number(chargeAmount || 0);
	if (!Number.isFinite(amount)) return;
	if (amount <= providerMaxAmount) return;

	throw createBillingError({
		code: BILLING_ERROR_CODES.PROVIDER_AMOUNT_CAP,
		status: 422,
		message: 'Montant de transaction au-dessus du plafond autorise par le fournisseur.',
		details: {
			chargeAmount: amount,
			currency,
			providerMaxAmount,
		},
	});
};

const normalizeMode = (mode) => {
	const value = String(mode || 'renewal').trim().toLowerCase();
	if (['upgrade', 'retry', 'renewal'].includes(value)) return value;
	return 'renewal';
};

const getRedirectUrl = () => {
	const base = String(process.env.FRONTEND_URL || '').replace(/\/+$/, '');
	return `${base}/billing.html`;
};

const getSigningSecret = () =>
	String(process.env.BILLING_SIGNING_SECRET || process.env.JWT_SECRET || '').trim();

const signCheckoutMetadata = (payload) => {
	const secret = getSigningSecret();
	if (!secret) {
		throw new Error('BILLING_SIGNING_SECRET manquant.');
	}
	return crypto
		.createHmac('sha256', secret)
		.update(JSON.stringify(payload), 'utf8')
		.digest('hex');
};

const buildCheckoutMetadata = ({ invoice, organizationId, mode }) => {
	const unsigned = {
		invoiceId: String(invoice?._id || ''),
		organizationId: String(organizationId || ''),
		invoiceKey: String(invoice?.invoiceKey || ''),
		mode: normalizeMode(mode),
	};
	return {
		...unsigned,
		signature: signCheckoutMetadata(unsigned),
	};
};

const validateSignedMetadata = ({ metadata, invoice, organizationId }) => {
	if (!metadata || typeof metadata !== 'object') {
		return { ok: true, skipped: true };
	}

	const invoiceId = String(metadata.invoiceId || '').trim();
	const orgId = String(metadata.organizationId || '').trim();
	const invoiceKey = String(metadata.invoiceKey || '').trim();
	const signature = String(metadata.signature || '').trim().toLowerCase();

	if (!invoiceId || invoiceId !== String(invoice?._id || '')) {
		return {
			ok: false,
			code: 'INVOICE_ID_MISMATCH',
			message: 'InvoiceId metadata incoherent.',
		};
	}
	if (!orgId || orgId !== String(organizationId || invoice?.organizationId || '')) {
		return {
			ok: false,
			code: 'ORG_ID_MISMATCH',
			message: 'OrganizationId metadata incoherent.',
		};
	}
	if (invoice?.invoiceKey && invoiceKey !== String(invoice.invoiceKey)) {
		return {
			ok: false,
			code: 'INVOICE_KEY_MISMATCH',
			message: 'InvoiceKey metadata incoherente.',
		};
	}

	const unsigned = {
		invoiceId,
		organizationId: orgId,
		invoiceKey,
		mode: normalizeMode(metadata.mode),
	};
	const expected = signCheckoutMetadata(unsigned).toLowerCase();
	if (!signature || signature !== expected) {
		return {
			ok: false,
			code: 'METADATA_SIGNATURE_INVALID',
			message: 'Signature metadata invalide.',
		};
	}

	return { ok: true };
};

const buildMerchantReference = ({ organizationId, invoice }) => {
	const payload = {
		invoiceId: String(invoice?._id || ''),
		organizationId: String(organizationId || ''),
		invoiceKey: String(invoice?.invoiceKey || ''),
		mode: 'ref',
	};
	const shortSignature = signCheckoutMetadata(payload).slice(0, 12);
	return `sapp:${payload.organizationId}:${payload.invoiceId}:${shortSignature}`;
};

const resolveBillingContact = async ({
	organizationId,
	fallbackEmail = null,
	fallbackName = null,
}) => {
	if (!organizationId) {
		return {
			email: fallbackEmail || null,
			name: fallbackName || 'Community Client',
		};
	}

	const organization = await Organization.findById(organizationId)
		.select('name ownerUserId')
		.lean();
	const owner = organization?.ownerUserId
		? await User.findById(organization.ownerUserId)
				.select('email pseudo name')
				.lean()
		: null;

	const email =
		String(owner?.email || fallbackEmail || '') ||
		String(process.env.BILLING_DEFAULT_EMAIL || '').trim() ||
		String(process.env.MAILJET_FROM_EMAIL || process.env.SUPPORT_INBOX_EMAIL || '').trim();
	const name =
		owner?.pseudo || owner?.name || organization?.name || fallbackName || 'Community Client';

	return {
		email:
			email ||
			String(process.env.SUPPORT_INBOX_EMAIL || '').trim() ||
			'community@local.invalid',
		name,
	};
};

const ensureInvoiceFxLock = async ({ invoice, quoteCurrency, forceRefresh = false }) => {
	if (!invoice) return null;

	const targetCurrency = normalizeQuoteCurrency(
		quoteCurrency || invoice?.charge?.currency || invoice?.fx?.quoteCurrency || 'XOF',
	);
	const hasChargeAmount = Number.isFinite(Number(invoice?.charge?.amount));

	if (
		!forceRefresh &&
		hasChargeAmount &&
		!isFxLockExpired(invoice) &&
		String(invoice?.fx?.quoteCurrency || '').toUpperCase() === targetCurrency
	) {
		return invoice;
	}

	const fxLock = await buildFxLock({
		amountUsd: toMoney(invoice.totalAmountUsd),
		quoteCurrency: targetCurrency,
	});

	invoice.fx = {
		baseCurrency: 'USD',
		quoteCurrency: fxLock.quoteCurrency,
		rate: fxLock.rate,
		source: fxLock.source,
		asOf: fxLock.asOf,
		lockedAt: fxLock.lockedAt,
		lockExpiresAt: fxLock.lockExpiresAt,
	};
	invoice.charge = {
		amount: fxLock.chargeAmount,
		currency: fxLock.quoteCurrency,
		minorUnitAmount: fxLock.minorUnitAmount,
	};
	await invoice.save();
	return invoice;
};

const getTransactionField = (transactionLike, pathCandidates = []) => {
	for (const candidate of pathCandidates) {
		const parts = String(candidate).split('.').filter(Boolean);
		let value = transactionLike;
		for (const part of parts) {
			if (value && typeof value === 'object' && part in value) {
				value = value[part];
			} else {
				value = undefined;
				break;
			}
		}
		if (value !== undefined && value !== null && String(value).trim() !== '') {
			return value;
		}
	}
	return null;
};

const validateVerifiedTransactionAgainstInvoice = ({
	invoice,
	verification,
	expectedReference,
	organizationId,
}) => {
	const normalizedStatus = String(
		getTransactionField(verification, ['status', 'transaction_status']) || '',
	)
		.trim()
		.toLowerCase();
	const acceptedStatuses = new Set(['approved', 'successful', 'paid']);
	if (!acceptedStatuses.has(normalizedStatus)) {
		return {
			ok: false,
			code: 'TX_STATUS_INVALID',
			message: 'Transaction FedaPay non approuvee.',
		};
	}

	const rawCurrency =
		getTransactionField(verification, ['currency.iso', 'currency.code', 'currency', 'currency_iso']) ||
		'';
	const normalizedCurrency = String(rawCurrency).trim().toUpperCase();
	if (normalizedCurrency !== String(invoice?.charge?.currency || '').trim().toUpperCase()) {
		return {
			ok: false,
			code: 'TX_CURRENCY_INVALID',
			message: 'Devise transaction incoherente.',
		};
	}

	const amount = Number(
		getTransactionField(verification, ['amount', 'amount_paid', 'transferred_amount']) || 0,
	);
	if (!Number.isFinite(amount) || amount < Number(invoice?.charge?.amount || 0)) {
		return {
			ok: false,
			code: 'TX_AMOUNT_INVALID',
			message: 'Montant transaction insuffisant.',
		};
	}

	const reference = String(
		getTransactionField(verification, ['reference', 'merchant_reference', 'tx_ref']) || '',
	)
		.trim();
	if (expectedReference && reference !== String(expectedReference)) {
		return {
			ok: false,
			code: 'TX_REFERENCE_MISMATCH',
			message: 'Reference transaction incoherente.',
		};
	}

	const metadata =
		getTransactionField(verification, ['custom_metadata', 'metadata']) ||
		getTransactionField(verification, ['transaction.custom_metadata', 'transaction.metadata']) ||
		null;
	if (metadata) {
		const metadataValidation = validateSignedMetadata({
			metadata,
			invoice,
			organizationId,
		});
		if (!metadataValidation.ok) {
			return metadataValidation;
		}
	}

	return { ok: true };
};

const markInvoicePaidAndActivateSubscription = async ({
	invoice,
	verification,
	transactionId = null,
	rawStatus = 'approved',
	targetPlanCode = null,
	chargeMode = 'checkout',
}) => {
	const paidAt = new Date();
	invoice.status = 'paid';
	invoice.paidAt = paidAt;
	invoice.provider = {
		...(invoice.provider || {}),
		name: 'fedapay',
		transactionId: transactionId ? String(transactionId) : invoice.provider?.transactionId || null,
		rawStatus: String(rawStatus || 'approved'),
		chargeMode,
	};
	await invoice.save();

	const subscription = await Subscription.findById(invoice.subscriptionId);
	if (!subscription) return { invoice, subscription: null };

	if (targetPlanCode) {
		subscription.planCode = String(targetPlanCode).trim().toUpperCase();
	}

	subscription.provider = {
		...(subscription.provider || {}),
		name: 'fedapay',
		canAutoCharge: false,
	};
	if (verification?.customer?.id) {
		subscription.provider.customerId = String(verification.customer.id);
	}

	subscription.status = SUBSCRIPTION_STATUSES.ACTIVE;
	subscription.lastPaidAt = paidAt;
	subscription.readOnlySince = null;
	subscription.graceEndsAt = null;
	subscription.currentPeriodStartAt = paidAt;
	subscription.currentPeriodEndAt = addMonthsUtc(paidAt, 1);
	subscription.nextBillingAt = subscription.currentPeriodEndAt;
	await subscription.save();

	return { invoice, subscription };
};

const markInvoiceFailedAndPastDue = async ({
	invoice,
	rawStatus = 'failed',
	transactionId = null,
	reason = null,
}) => {
	invoice.status = 'failed';
	invoice.provider = {
		...(invoice.provider || {}),
		name: 'fedapay',
		transactionId: transactionId ? String(transactionId) : invoice.provider?.transactionId || null,
		rawStatus: String(rawStatus || 'failed'),
	};
	await invoice.save();

	const subscription = await Subscription.findById(invoice.subscriptionId);
	if (subscription) {
		subscription.status = SUBSCRIPTION_STATUSES.PAST_DUE;
		subscription.graceEndsAt = addDaysUtc(new Date(), TRIAL_SETTINGS.graceDays);
		await subscription.save();
	}

	if (reason) {
		await logSecurityEvent({
			event: 'billing_payment_failed',
			level: 'warning',
			action: 'invoice_payment',
			code: String(reason.code || 'PAYMENT_FAILED'),
			message: String(reason.message || 'Paiement facture en echec.'),
			organizationId: invoice.organizationId,
			meta: {
				invoiceId: String(invoice._id),
				totalAmountUsd: Number(invoice.totalAmountUsd || 0),
			},
		});
	}

	return { invoice, subscription };
};

const createCheckoutForInvoice = async ({
	invoice,
	organizationId,
	customerEmail,
	customerName,
	mode = 'renewal',
	quoteCurrency = 'XOF',
}) => {
	if (Number(invoice?.totalAmountUsd || 0) <= 0) {
		await markInvoicePaidAndActivateSubscription({
			invoice,
			verification: null,
			transactionId: 'NO_CHARGE',
			rawStatus: 'no_charge_required',
			chargeMode: 'manual',
			targetPlanCode: invoice?.metadata?.targetPlanCode || null,
		});
		return {
			invoice,
			checkoutData: null,
			noCharge: true,
		};
	}

	if (
		String(invoice?.status || '').toLowerCase() === 'pending' &&
		String(invoice?.provider?.checkoutLink || '').trim() &&
		!isFxLockExpired(invoice)
	) {
		return {
			invoice,
			checkoutData: {
				link: invoice.provider.checkoutLink,
				transactionId: invoice.provider.transactionId || null,
				token: null,
			},
			noCharge: false,
		};
	}

	await ensureInvoiceFxLock({
		invoice,
		quoteCurrency,
		forceRefresh: isFxLockExpired(invoice),
	});

	const merchantReference =
		String(invoice?.provider?.txRef || '').trim() ||
		buildMerchantReference({ organizationId, invoice });

	const metadata = buildCheckoutMetadata({ invoice, organizationId, mode });
	const callbackUrl = `${getRedirectUrl()}?invoiceId=${encodeURIComponent(String(invoice._id))}`;
	const chargeAmount = Number(invoice?.charge?.amount || 0);
	const chargeCurrency = String(invoice?.charge?.currency || quoteCurrency).trim().toUpperCase();
	let transaction = null;
	let transactionId = null;

	try {
		assertProviderAmountCap({ chargeAmount, chargeCurrency });

		transaction = await createTransaction({
			chargeAmount,
			chargeCurrency,
			description: `Community Billing ${String(invoice?.kind || 'renewal').toUpperCase()}`,
			callbackUrl,
			merchantReference,
			customerEmail,
			customerName,
			metadata,
		});

		transactionId =
			String(transaction?.id || transaction?.transaction_id || '').trim() || null;
		if (!transactionId) {
			throw new Error('Transaction FedaPay creee sans identifiant exploitable.');
		}

		const tokenPayload = await generateCheckoutToken({ transactionId });
		const checkoutLink = tokenPayload?.url || null;
		if (!checkoutLink) {
			throw new Error('Lien checkout FedaPay indisponible.');
		}

		invoice.provider = {
			...(invoice.provider || {}),
			name: 'fedapay',
			txRef: merchantReference,
			transactionId,
			checkoutLink,
			rawStatus: String(transaction?.status || 'initialized'),
			chargeMode: 'manual',
		};
		if (!invoice.status || invoice.status === 'failed') {
			invoice.status = 'pending';
		}
		await invoice.save();

		return {
			invoice,
			checkoutData: {
				link: checkoutLink,
				transactionId,
				token: tokenPayload?.token || null,
			},
			noCharge: false,
		};
	} catch (error) {
		const existingMetadata =
			invoice?.metadata && typeof invoice.metadata === 'object' && !Array.isArray(invoice.metadata)
				? invoice.metadata
				: {};
		invoice.status = 'failed';
		invoice.provider = {
			...(invoice.provider || {}),
			name: 'fedapay',
			txRef: merchantReference,
			transactionId: transactionId || invoice?.provider?.transactionId || null,
			checkoutLink: null,
			rawStatus: String(error?.code || error?.status || 'checkout_init_failed'),
			chargeMode: 'manual',
		};
		invoice.metadata = {
			...existingMetadata,
			checkoutInitError: {
				code: String(error?.code || ''),
				message: String(error?.message || 'Checkout initialization failed.'),
				at: new Date().toISOString(),
			},
		};
		await invoice.save();
		throw error;
	}
};

const findOrCreateInvoiceForOperation = async ({
	organizationId,
	subscription,
	plan,
	usage,
	mode,
	targetPlanCode = null,
}) => {
	const normalizedMode = normalizeMode(mode);
	const subscriptionStatus = String(subscription?.status || '').trim().toLowerCase();
	if (
		subscriptionStatus === SUBSCRIPTION_STATUSES.TRIALING &&
		['renewal', 'upgrade', 'retry'].includes(normalizedMode)
	) {
		throw createBillingError({
			code: BILLING_ERROR_CODES.TRIALING_LOCKED,
			status: 409,
			message: "Essai gratuit en cours: la facturation est verrouillee jusqu'a la fin de l'essai.",
			details: {
				subscriptionStatus,
				trialEndsAt: subscription?.trialEndsAt || null,
			},
		});
	}

	if (normalizedMode === 'retry') {
		const existing = await Invoice.findOne({
			organizationId,
			status: { $in: ['failed', 'pending'] },
		}).sort({ createdAt: -1 });
		if (existing) return existing;
	}

	const kind =
		normalizedMode === 'upgrade' ? 'upgrade' : normalizedMode === 'retry' ? 'retry' : 'renewal';
	const periodKey = getPeriodKeyUtc(new Date());
	const invoiceKey = buildInvoiceKey({
		kind,
		organizationId,
		periodKey,
		subscriptionId: subscription?._id || null,
		targetPlanCode,
	});

	if (invoiceKey) {
		const existingByKey = await Invoice.findOne({ invoiceKey });
		if (existingByKey) return existingByKey;
	}

	const draft = await buildInvoiceDraft({
		organizationId,
		subscription,
		plan,
		usage,
		kind,
		periodKey,
		targetPlanCode,
	});
	return Invoice.create({
		...draft,
		metadata: targetPlanCode ? { targetPlanCode } : null,
	});
};

// Kept for backward compatibility with the existing controller/lifecycle call sites.
const attemptAutoRenewalCharge = async ({
	subscription,
	invoice,
	customerEmail,
	customerName,
	organizationId,
	mode = 'renewal',
}) => {
	const organization = organizationId
		? await Organization.findById(organizationId).select('paymentCurrency currency').lean()
		: null;
	const quoteCurrency = String(
		organization?.paymentCurrency ||
			organization?.currency ||
			invoice?.charge?.currency ||
			'XOF',
	)
		.trim()
		.toUpperCase();
	const checkout = await createCheckoutForInvoice({
		invoice,
		organizationId,
		customerEmail,
		customerName,
		mode,
		quoteCurrency,
	});
	return {
		mode: 'checkout',
		invoice: checkout.invoice,
		checkoutData: checkout.checkoutData,
		noCharge: checkout.noCharge,
		paid: String(checkout?.invoice?.status || '').toLowerCase() === 'paid',
	};
};

module.exports = {
	resolveBillingContact,
	findOrCreateInvoiceForOperation,
	createCheckoutForInvoice,
	attemptAutoRenewalCharge,
	validateVerifiedTransactionAgainstInvoice,
	markInvoicePaidAndActivateSubscription,
	markInvoiceFailedAndPastDue,
	ensureInvoiceFxLock,
	buildCheckoutMetadata,
	validateSignedMetadata,
	__test: {
		getFedaPayMaxAmountXof,
		assertProviderAmountCap,
	},
};
