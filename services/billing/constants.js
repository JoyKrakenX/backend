/** @format */

const { normalizeEmail } = require('../../utils/supportAdminAllowlist');

const PLAN_CODES = Object.freeze({
	UNLIMITED: 'UNLIMITED',
	// Legacy codes remain as identifiers only; plan resolution maps them to UNLIMITED.
	FREE: 'FREE',
	STARTER: 'STARTER',
	GROWTH: 'GROWTH',
	SCALE: 'SCALE',
	ENTERPRISE: 'ENTERPRISE',
});

const PUBLIC_PLAN_CODES = Object.freeze([PLAN_CODES.UNLIMITED]);

const ADDON_CODES = Object.freeze({});

const UNLIMITED_QUOTAS = Object.freeze({
	votes: null,
	chatConcurrent: null,
	surveys: null,
	admins: null,
	exports: null,
});

const PLAN_CATALOG = Object.freeze([
	{
		code: PLAN_CODES.UNLIMITED,
		displayName: 'Community Unlimited',
		priceMonthlyUsd: 45,
		priceLabel: '45 USD / mois',
		isQuoteOnly: false,
		quotas: UNLIMITED_QUOTAS,
		features: {
			chatEnabled: true,
			exportsEnabled: true,
			privateSurveysEnabled: true,
		},
		isPublic: true,
		isSelectable: true,
		recommended: true,
		publicOrder: 10,
		audience: 'Organisations, médias, marques et équipes qui veulent activer leur audience.',
		description:
			'Une offre organisationnelle unique: sondages, votes, chatroom, exports, analytics et admins en illimité. Les participants restent gratuits.',
		highlights: Object.freeze([
			'14 jours d essai gratuits',
			'Sondages illimites',
			'Votes et participants illimites',
			'Chatroom illimitee',
			'Exports et analytics illimites',
			'Admins organisation illimites',
		]),
		ctaLabel: 'Activer Community Unlimited',
		availableAddonCodes: Object.freeze([]),
		trialEligible: true,
	},
]);

const ADDON_CATALOG = Object.freeze([]);

const TRIAL_SETTINGS = Object.freeze({
	basePlanCode: PLAN_CODES.UNLIMITED,
	trialPlanCode: PLAN_CODES.UNLIMITED,
	durationDays: 14,
	paymentGraceDays: 4,
});

const COMMERCIAL_RULES = Object.freeze({
	entryPlanCode: PLAN_CODES.UNLIMITED,
	trialPlanCode: PLAN_CODES.UNLIMITED,
	trialDays: TRIAL_SETTINGS.durationDays,
	hasAnnualPricing: false,
	annualDiscountPercent: null,
	quotaAlerts: Object.freeze([]),
	billingModel: 'single_unlimited_organization_subscription',
	checkoutMode: 'manual_checkout',
	currency: 'USD',
});

const ENTERPRISE_TEASER = Object.freeze({
	code: PLAN_CODES.UNLIMITED,
	displayName: 'Community Unlimited',
	priceLabel: '45 USD / mois',
	isQuoteOnly: false,
	isSelectable: true,
	description: 'Une seule offre organisationnelle illimitee, avec accompagnement sur demande.',
	contactUrl: 'contact.html?topic=billing-sales&source=billing',
});

const SUBSCRIPTION_STATUSES = Object.freeze({
	TRIALING: 'trialing',
	ACTIVE: 'active',
	GRACE: 'grace',
	PAST_DUE: 'past_due',
	SUSPENDED: 'suspended',
	CANCELED: 'canceled',
});

const ENTITLEMENT_ACTIONS = Object.freeze({
	CREATE_SURVEY: 'create_survey',
	VOTE: 'vote',
	EXPORT: 'export',
	JOIN_CHAT: 'join_chat',
	MANAGE_ADMINS: 'manage_admins',
});

const ENTITLEMENT_DENY_CODES = Object.freeze({
	NO_ORG: 'NO_ORG',
	NO_SUBSCRIPTION: 'NO_SUBSCRIPTION',
	READ_ONLY: 'READ_ONLY',
	FEATURE_DISABLED: 'FEATURE_DISABLED',
	SURVEYS_LIMIT_REACHED: 'SURVEYS_LIMIT_REACHED',
	EXPORTS_LIMIT_REACHED: 'EXPORTS_LIMIT_REACHED',
	RESPONSES_LIMIT_REACHED: 'RESPONSES_LIMIT_REACHED',
	LIVE_CONCURRENT_LIMIT_REACHED: 'LIVE_CONCURRENT_LIMIT_REACHED',
	ADMINS_LIMIT_REACHED: 'ADMINS_LIMIT_REACHED',
	FORBIDDEN: 'FORBIDDEN',
});

const BILLING_FAQ = Object.freeze([
	{
		question: 'Qui paie sur Community ?',
		answer:
			"L'abonnement est porte par l'organisation qui publie et pilote les sondages. Les participants, votants et membres de communauté restent gratuits.",
	},
	{
		question: 'Que comprend Community Unlimited ?',
		answer:
			'Pour 45 USD par mois apres 14 jours d essai, l organisation dispose de sondages, votes, chatroom, exports, analytics et admins en illimite.',
	},
	{
		question: 'Y a-t-il encore des limites de votes ou de chat ?',
		answer:
			'Non. Les compteurs restent disponibles pour l analyse interne, mais ils ne bloquent plus les fonctionnalites.',
	},
	{
		question: 'Que se passe-t-il apres l essai gratuit ?',
		answer:
			"L'organisation conserve l acces selon son etat d abonnement. Si le paiement doit etre regularise, seules les regles de paiement et de securite s appliquent, pas des quotas de volume.",
	},
]);

const BILLING_PRINCIPLES = Object.freeze([
	'Les participants ne paient pas.',
	"L abonnement est porte par l organisation qui publie et anime.",
	'Une seule offre: 45 USD / mois, 14 jours d essai gratuits.',
	'Sondages, votes, chatroom, exports, analytics et admins sont illimites.',
	'Les compteurs d usage servent au pilotage, jamais au blocage par quota.',
]);

const STATIC_BILLING_EXEMPT_EMAILS = new Set([
	normalizeEmail('tomseigneurjoyagbossou@gmail.com'),
]);

module.exports = {
	PLAN_CODES,
	PUBLIC_PLAN_CODES,
	ADDON_CODES,
	PLAN_CATALOG,
	ADDON_CATALOG,
	TRIAL_SETTINGS,
	COMMERCIAL_RULES,
	ENTERPRISE_TEASER,
	SUBSCRIPTION_STATUSES,
	ENTITLEMENT_ACTIONS,
	ENTITLEMENT_DENY_CODES,
	BILLING_FAQ,
	BILLING_PRINCIPLES,
	STATIC_BILLING_EXEMPT_EMAILS,
};
