/** @format */

const mongoose = require('mongoose');

const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const Subscription = require('../models/Subscription');
const { ensureDefaultSubscription } = require('./billing/subscriptionService');

const toObjectId = (id) =>
	mongoose.Types.ObjectId.isValid(String(id || ''))
		? mongoose.Types.ObjectId.createFromHexString(String(id))
		: null;

const slugify = (value) =>
	String(value || '')
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80);

const buildPersonalOrganizationName = (user) => {
	const pseudo = String(user?.pseudo || '').trim();
	if (pseudo) return `${pseudo} Studio`;
	const name = String(user?.name || '').trim();
	if (name) return `${name} Studio`;
	const email = String(user?.email || '').trim();
	const prefix = email.split('@')[0];
	return `${prefix || 'Community'} Studio`;
};

const ensureTrialSubscriptionForOrganization = async (organizationId, now = new Date()) => {
	const existing = await Subscription.findOne({ organizationId }).lean();
	if (existing) return existing;
	const created = await ensureDefaultSubscription(organizationId, now);
	return created?.toObject ? created.toObject() : created;
};

const ensureOwnerMembership = async (organizationId, ownerUserId) => {
	await OrganizationMember.findOneAndUpdate(
		{ organizationId, userId: ownerUserId },
		{
			$set: {
				role: 'owner',
			},
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true },
	);
};

const ensurePersonalOrganizationForUser = async (userLike) => {
	const userId = toObjectId(userLike?._id || userLike?.id || userLike?.userId);
	if (!userId) return null;
	const user = await User.findById(userId);
	if (!user) return null;

	let organization = null;
	if (user.defaultOrganizationId) {
		organization = await Organization.findById(user.defaultOrganizationId);
	}

	if (!organization) {
		organization = await Organization.findOne({ ownerUserId: user._id }).sort({
			createdAt: 1,
		});
	}

	if (!organization) {
		const baseName = buildPersonalOrganizationName(user);
		const baseSlug = slugify(baseName) || `org-${String(user._id).slice(-6)}`;
		let slug = baseSlug;
		let attempt = 1;
		while (await Organization.findOne({ slug }).lean()) {
			attempt += 1;
			slug = `${baseSlug}-${attempt}`;
		}

		organization = await Organization.create({
			name: baseName,
			slug,
			ownerUserId: user._id,
			status: 'active',
			timezone: 'UTC',
			currency: 'USD',
			paymentCurrency: 'XOF',
		});
	}

	await ensureOwnerMembership(organization._id, user._id);
	if (!user.defaultOrganizationId || String(user.defaultOrganizationId) !== String(organization._id)) {
		user.defaultOrganizationId = organization._id;
		await user.save();
	}

	await ensureTrialSubscriptionForOrganization(organization._id);
	return organization.toObject();
};

const getOrganizationMembers = async (organizationId) =>
	OrganizationMember.find({ organizationId })
		.populate('userId', '_id pseudo email name picture role')
		.sort({ role: 1, createdAt: 1 })
		.lean();

const getAdminCountForOrganization = async (organizationId) =>
	OrganizationMember.countDocuments({
		organizationId,
		role: { $in: ['owner', 'admin'] },
	});

const listUserOrganizations = async (userId) => {
	const memberships = await OrganizationMember.find({ userId })
		.populate('organizationId')
		.lean();
	return memberships
		.filter((entry) => entry?.organizationId)
		.map((entry) => ({
			organization: entry.organizationId,
			role: entry.role,
		}));
};

const resolveActiveOrganizationContext = async ({
	userId,
	userEmail: _userEmail,
	requestedOrganizationId,
}) => {
	const user = await User.findById(userId).lean();
	if (!user) {
		return {
			ok: false,
			code: 'USER_NOT_FOUND',
		};
	}

	await ensurePersonalOrganizationForUser(user);
	const refreshedUser = await User.findById(userId).lean();

	let targetOrganizationId = requestedOrganizationId || refreshedUser?.defaultOrganizationId;
	if (!targetOrganizationId) {
		return {
			ok: false,
			code: 'NO_ORG',
		};
	}

	const organization = await Organization.findById(targetOrganizationId).lean();
	if (!organization) {
		return {
			ok: false,
			code: 'ORG_NOT_FOUND',
		};
	}

	const member = await OrganizationMember.findOne({
		organizationId: organization._id,
		userId: refreshedUser._id,
	}).lean();

	if (!member) {
		return {
			ok: false,
			code: 'FORBIDDEN',
		};
	}

	return {
		ok: true,
		organization,
		role: member.role,
		isSuperAdmin: false,
		member,
		user: refreshedUser,
	};
};

module.exports = {
	toObjectId,
	ensurePersonalOrganizationForUser,
	listUserOrganizations,
	resolveActiveOrganizationContext,
	getOrganizationMembers,
	getAdminCountForOrganization,
	ensureTrialSubscriptionForOrganization,
};
