/** @format */

const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Subscription = require('../models/Subscription');
const SubscriptionAddon = require('../models/SubscriptionAddon');
const Invoice = require('../models/Invoice');
const PaymentEvent = require('../models/PaymentEvent');
const Plan = require('../models/Plan');
const UsageMonthly = require('../models/UsageMonthly');
const UsageEvent = require('../models/UsageEvent');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const Opinion = require('../models/Opinion');
const Opinion_2 = require('../models/Opinion_2');
const Opinion_Flash = require('../models/Opinion_Flash');
const Opinion_2_Flash = require('../models/Opinion_2_Flash');
const ChatMessage = require('../models/ChatMessage');
const SupportTicket = require('../models/SupportTicket');
const SupportMessage = require('../models/SupportMessage');
const SupportConversation = require('../models/SupportConversation');
const SupportPushSubscription = require('../models/SupportPushSubscription');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const UserPrivacySettings = require('../models/UserPrivacySettings');
const SecurityAuditLog = require('../models/SecurityAuditLog');
const FraudDecisionLog = require('../models/FraudDecisionLog');

const collectionNames = (models) =>
	models.map((model) => model.collection.collectionName);

const DATA_COLLECTIONS = Object.freeze(
	collectionNames([
		User,
		Organization,
		OrganizationMember,
		Subscription,
		SubscriptionAddon,
		Invoice,
		PaymentEvent,
		Plan,
		UsageMonthly,
		UsageEvent,
		Survey,
		Survey_2,
		Opinion,
		Opinion_2,
		Opinion_Flash,
		Opinion_2_Flash,
		ChatMessage,
		SupportTicket,
		SupportMessage,
		SupportConversation,
		SupportPushSubscription,
		NewsletterSubscriber,
		UserPrivacySettings,
		SecurityAuditLog,
		FraudDecisionLog,
	]),
);

const PURGE_ORDER = Object.freeze(
	collectionNames([
		SupportMessage,
		SupportConversation,
		SupportTicket,
		SupportPushSubscription,
		ChatMessage,
		Opinion,
		Opinion_2,
		Opinion_Flash,
		Opinion_2_Flash,
		Survey,
		Survey_2,
		UsageEvent,
		UsageMonthly,
		SubscriptionAddon,
		Invoice,
		PaymentEvent,
		OrganizationMember,
		Subscription,
		NewsletterSubscriber,
		UserPrivacySettings,
		SecurityAuditLog,
		FraudDecisionLog,
		Plan,
		Organization,
		User,
	]),
);

const RESTORE_ORDER = Object.freeze(
	collectionNames([
		Plan,
		User,
		Organization,
		OrganizationMember,
		Subscription,
		SubscriptionAddon,
		Invoice,
		PaymentEvent,
		UsageMonthly,
		UsageEvent,
		Survey,
		Survey_2,
		Opinion,
		Opinion_2,
		Opinion_Flash,
		Opinion_2_Flash,
		ChatMessage,
		SupportTicket,
		SupportConversation,
		SupportMessage,
		SupportPushSubscription,
		NewsletterSubscriber,
		UserPrivacySettings,
		SecurityAuditLog,
		FraudDecisionLog,
	]),
);

module.exports = {
	DATA_COLLECTIONS,
	PURGE_ORDER,
	RESTORE_ORDER,
};
