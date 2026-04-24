/** @format */

const { normalizeEmail } = require('../../utils/supportAdminAllowlist');

const PLAN_CODES = Object.freeze({
	FREE: 'FREE',
	STARTER: 'STARTER',
	GROWTH: 'GROWTH',
	SCALE: 'SCALE',
	ENTERPRISE: 'ENTERPRISE',
});

const PUBLIC_PLAN_CODES = Object.freeze([
	PLAN_CODES.FREE,
	PLAN_CODES.STARTER,
	PLAN_CODES.GROWTH,
	PLAN_CODES.SCALE,
	PLAN_CODES.ENTERPRISE,
]);

const ADDON_CODES = Object.freeze({
	RESPONSE_PACK_50K: 'RESPONSE_PACK_50K',
	ADMIN_PACK_5: 'ADMIN_PACK_5',
	LIVE_EVENT_BOOST_72H: 'LIVE_EVENT_BOOST_72H',
});

const PLAN_CATALOG = Object.freeze([
	{
		code: PLAN_CODES.FREE,
		displayName: 'Free',
		priceMonthlyUsd: 0,
		priceLabel: '0 USD / mois',
		isQuoteOnly: false,
		quotas: {
			votes: 1500,
			chatConcurrent: 50,
			surveys: 3,
			admins: 1,
			exports: 0,
		},
		features: {
			chatEnabled: true,
			exportsEnabled: false,
			privateSurveysEnabled: false,
		},
		isPublic: true,
		isSelectable: true,
		recommended: false,
		publicOrder: 10,
		audience: 'Decouverte',
		description:
			'Pour découvrir Community sans friction avec une capacité volontairement limitée.',
		highlights: Object.freeze([
			'1 organisation',
			'1 admin',
			'3 campagnes interactives / mois',
			'1 500 réponses / mois',
			'50 simultanes live',
			'Branding Community conserve',
		]),
		ctaLabel: 'Commencer gratuitement',
		availableAddonCodes: Object.freeze([]),
		trialEligible: false,
	},
	{
		code: PLAN_CODES.STARTER,
		displayName: 'Starter',
		priceMonthlyUsd: 15,
		priceLabel: null,
		isQuoteOnly: false,
		quotas: {
			votes: 15000,
			chatConcurrent: 200,
			surveys: null,
			admins: 3,
			exports: 10,
		},
		features: {
			chatEnabled: true,
			exportsEnabled: true,
			privateSurveysEnabled: true,
		},
		isPublic: true,
		isSelectable: true,
		recommended: false,
		publicOrder: 20,
		audience: 'Createurs, assos, petites structures',
		description:
			'Pour les équipes qui animent déjà une petite audience avec un besoin simple et régulier.',
		highlights: Object.freeze([
			'3 admins',
			'Sondages illimites',
			'15 000 réponses / mois',
			'200 simultanes live',
			'10 exports / mois',
			'QR, chat et partage inclus',
		]),
		ctaLabel: 'Choisir Starter',
		availableAddonCodes: Object.freeze([
			ADDON_CODES.RESPONSE_PACK_50K,
			ADDON_CODES.ADMIN_PACK_5,
			ADDON_CODES.LIVE_EVENT_BOOST_72H,
		]),
		trialEligible: false,
	},
	{
		code: PLAN_CODES.GROWTH,
		displayName: 'Growth',
		priceMonthlyUsd: 49,
		priceLabel: null,
		isQuoteOnly: false,
		quotas: {
			votes: 75000,
			chatConcurrent: 1000,
			surveys: null,
			admins: 10,
			exports: null,
		},
		features: {
			chatEnabled: true,
			exportsEnabled: true,
			privateSurveysEnabled: true,
		},
		isPublic: true,
		isSelectable: true,
		recommended: true,
		publicOrder: 30,
		audience: 'PME, agences, équipes qui animent déjà une audience',
		description:
			'Pour faire de l’engagement un levier régulier avec davantage de capacité, de collaboration et d’analyse.',
		highlights: Object.freeze([
			'10 admins',
			'Sondages illimites',
			'75 000 réponses / mois',
			'1 000 simultanes live',
			'Exports illimites',
			'Analytics renforcées',
		]),
		ctaLabel: 'Passer a Growth',
		availableAddonCodes: Object.freeze([
			ADDON_CODES.RESPONSE_PACK_50K,
			ADDON_CODES.ADMIN_PACK_5,
			ADDON_CODES.LIVE_EVENT_BOOST_72H,
		]),
		trialEligible: true,
	},
	{
		code: PLAN_CODES.SCALE,
		displayName: 'Scale',
		priceMonthlyUsd: 149,
		priceLabel: null,
		isQuoteOnly: false,
		quotas: {
			votes: 300000,
			chatConcurrent: 3000,
			surveys: null,
			admins: 25,
			exports: null,
		},
		features: {
			chatEnabled: true,
			exportsEnabled: true,
			privateSurveysEnabled: true,
		},
		isPublic: true,
		isSelectable: true,
		recommended: false,
		publicOrder: 40,
		audience: 'Marques, médias, événements à fort trafic',
		description:
			'Pour les dispositifs d’activation à grande échelle avec une gouvernance d’équipe plus large.',
		highlights: Object.freeze([
			'25 admins',
			'Sondages illimites',
			'300 000 réponses / mois',
			'3 000 simultanes live',
			'Exports illimites',
			'Gouvernance équipe étendue',
		]),
		ctaLabel: 'Choisir Scale',
		availableAddonCodes: Object.freeze([
			ADDON_CODES.RESPONSE_PACK_50K,
			ADDON_CODES.ADMIN_PACK_5,
			ADDON_CODES.LIVE_EVENT_BOOST_72H,
		]),
		trialEligible: false,
	},
	{
		code: PLAN_CODES.ENTERPRISE,
		displayName: 'Enterprise',
		priceMonthlyUsd: null,
		priceLabel: 'Sur devis',
		isQuoteOnly: true,
		quotas: {
			votes: null,
			chatConcurrent: null,
			surveys: null,
			admins: null,
			exports: null,
		},
		features: {
			chatEnabled: true,
			exportsEnabled: true,
			privateSurveysEnabled: true,
		},
		isPublic: true,
		isSelectable: false,
		recommended: false,
		publicOrder: 50,
		audience: 'Diffuseurs, grands evenements, grands comptes',
		description: 'Pour les besoins strategiques et les cadres contractuels sur mesure.',
		highlights: Object.freeze([]),
		ctaLabel: "Parler à l'équipe",
		availableAddonCodes: Object.freeze([]),
		trialEligible: false,
	},
]);

const ADDON_CATALOG = Object.freeze([
	{
		code: ADDON_CODES.RESPONSE_PACK_50K,
		displayName: 'Response Pack 50k',
		description:
			'Ajoutez 50 000 réponses à votre capacité mensuelle sans changer immédiatement de plan.',
		priceUsd: 19,
		kind: 'one_time',
		durationType: 'billing_cycle',
		increments: {
			votes: 50000,
			chatConcurrent: 0,
			admins: 0,
			surveys: 0,
			exports: 0,
		},
		isPublic: true,
		publicOrder: 10,
		eligiblePlanCodes: Object.freeze([
			PLAN_CODES.STARTER,
			PLAN_CODES.GROWTH,
			PLAN_CODES.SCALE,
		]),
		maxQuantityPerCheckout: 10,
		ctaLabel: 'Ajouter des réponses',
	},
	{
		code: ADDON_CODES.ADMIN_PACK_5,
		displayName: 'Admin Pack 5 seats',
		description:
			'Ajoutez 5 admins lorsque votre équipe s’élargit ou que votre organisation se structure.',
		priceUsd: 15,
		kind: 'recurring',
		durationType: 'monthly',
		increments: {
			votes: 0,
			chatConcurrent: 0,
			admins: 5,
			surveys: 0,
			exports: 0,
		},
		isPublic: true,
		publicOrder: 20,
		eligiblePlanCodes: Object.freeze([
			PLAN_CODES.STARTER,
			PLAN_CODES.GROWTH,
			PLAN_CODES.SCALE,
		]),
		maxQuantityPerCheckout: 10,
		ctaLabel: 'Ajouter des admins',
	},
	{
		code: ADDON_CODES.LIVE_EVENT_BOOST_72H,
		displayName: 'Live Event Boost +1 000 simultanes / 72h',
		description:
			'Activez un boost temporaire pour un débat, une émission, un direct ou un événement spécial.',
		priceUsd: 49,
		kind: 'one_time',
		durationType: 'fixed_hours',
		durationHours: 72,
		increments: {
			votes: 0,
			chatConcurrent: 1000,
			admins: 0,
			surveys: 0,
			exports: 0,
		},
		isPublic: true,
		publicOrder: 30,
		eligiblePlanCodes: Object.freeze([
			PLAN_CODES.STARTER,
			PLAN_CODES.GROWTH,
			PLAN_CODES.SCALE,
		]),
		maxQuantityPerCheckout: 5,
		ctaLabel: 'Activer un boost live',
	},
]);

const TRIAL_SETTINGS = Object.freeze({
	basePlanCode: PLAN_CODES.FREE,
	trialPlanCode: PLAN_CODES.GROWTH,
	durationDays: 14,
	paymentGraceDays: 4,
});

const COMMERCIAL_RULES = Object.freeze({
	entryPlanCode: TRIAL_SETTINGS.basePlanCode,
	trialPlanCode: TRIAL_SETTINGS.trialPlanCode,
	trialDays: TRIAL_SETTINGS.durationDays,
	hasAnnualPricing: false,
	annualDiscountPercent: null,
	quotaAlerts: Object.freeze([70, 90, 100]),
	billingModel: 'upgrade_or_addon',
	checkoutMode: 'manual_checkout',
	currency: 'USD',
});

const ENTERPRISE_TEASER = Object.freeze({
	code: PLAN_CODES.ENTERPRISE,
	displayName: 'Enterprise',
	priceLabel: 'Sur devis',
	isQuoteOnly: true,
	isSelectable: false,
	description: 'Accompagnement commercial et capacites sur mesure.',
	contactUrl: 'contact.html?topic=enterprise-sales&source=billing&plan=ENTERPRISE',
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
		question: 'Qui doit payer sur Community ?',
		answer:
			"L'abonnement est porté par l'organisation qui publie, anime et exploite les campagnes sur Community. Les participants ne paient pas.",
	},
	{
		question: 'Les participants ont-ils besoin d un abonnement ?',
		answer:
			'Non. Les participants restent gratuits. Community facture les organisations éditrices, pas les votants.',
	},
	{
		question: "Que se passe-t-il quand j atteins la limite de mon plan ?",
		answer:
			'Vous ne subissez pas de dépassement caché. Vous pouvez passer au plan supérieur ou ajouter un pack explicite avec un coût connu à l’avance.',
	},
	{
		question: 'Y a-t-il un essai gratuit ?',
		answer:
			'Oui. Community propose Free en accès permanent, ainsi qu’un essai Growth de 14 jours pour découvrir une capacité plus intensive.',
	},
	{
		question: 'Puis-je passer au payant pendant l essai ?',
		answer:
			'Oui. Si votre besoin se confirme pendant l essai, vous pouvez passer a une offre payante sans attendre la fin de la periode.',
	},
	{
		question: 'Que compte Community comme réponse / participation ?',
		answer:
			'Une réponse correspond à une participation effectivement enregistrée sur vos campagnes interactives pendant votre cycle de facturation.',
	},
	{
		question: 'Puis-je acheter plus de capacite sans changer de plan ?',
		answer:
			'Oui. Si votre besoin est ponctuel, vous pouvez ajouter des packs de capacite ou de simultaneite sans changer immediatement de plan.',
	},
	{
		question: 'Dans quelle devise vais-je payer ?',
		answer:
			'Les offres sont présentées en USD. Le montant final est confirmé avant le checkout selon la devise de règlement applicable à votre organisation.',
	},
]);

const BILLING_PRINCIPLES = Object.freeze([
	'Les participants ne paient pas.',
	"L'abonnement est porté par l'organisation qui publie et anime.",
	'Vous choisissez un plan selon votre audience, votre equipe et votre intensite live.',
	'Si vous avez un besoin ponctuel, vous ajoutez un pack clair au lieu de subir un dépassement opaque.',
	'Le montant final est toujours confirme avant le checkout.',
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
