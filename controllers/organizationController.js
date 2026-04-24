/** @format */

const { z } = require('zod');
const { randomUUID } = require('crypto');

const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const { listUserOrganizations } = require('../services/organizationService');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { syncAdminsPeak } = require('../services/billing/usageService');
const { emitOrganizationMembershipUpdate } = require('../sockets/surveyFeedHandlers');

const addMemberSchema = z.object({
	userId: z.string().trim().min(1).optional(),
	email: z.string().trim().email().optional(),
	role: z.enum(['admin', 'member']).default('member'),
});

const updateMemberSchema = z.object({
	role: z.enum(['admin', 'member']),
});

const resolveUserByIdOrEmail = async ({ userId, email }) => {
	if (userId) {
		return User.findById(userId).select('_id pseudo email name picture').lean();
	}
	if (email) {
		return User.findOne({ email: String(email).trim().toLowerCase() })
			.select('_id pseudo email name picture')
			.lean();
	}
	return null;
};

const canManageOrganizationMembers = async (organizationId, userId) => {
	const member = await OrganizationMember.findOne({
		organizationId,
		userId,
	})
		.select('role')
		.lean();
	return ['owner', 'admin'].includes(String(member?.role || ''));
};

const mapMembership = (member) => ({
	_id: member?._id,
	role: member?.role,
	createdAt: member?.createdAt,
	updatedAt: member?.updatedAt,
	user:
		member?.userId && typeof member.userId === 'object' ?
			{
				_id: member.userId._id,
				pseudo: member.userId.pseudo || null,
				email: member.userId.email || null,
				name: member.userId.name || null,
				picture: member.userId.picture || null,
			}
		:	null,
});

exports.getMine = async (req, res) => {
	try {
		const organizations = await listUserOrganizations(req.userId);
		return res.status(200).json(
			organizations.map((entry) => ({
				organization: entry.organization,
				role: entry.role,
				isSuperAdmin: false,
				isActive:
					String(entry.organization?._id || '') ===
					String(req.activeOrganizationId || ''),
			})),
		);
	} catch (error) {
		console.error('organizations.getMine:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.getMembers = async (req, res) => {
	try {
		const organizationId = req.params.orgId;
		const canManage = await canManageOrganizationMembers(organizationId, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}

		const members = await OrganizationMember.find({ organizationId })
			.populate('userId', '_id pseudo email name picture role')
			.sort({ role: 1, createdAt: 1 })
			.lean();
		return res.status(200).json(members.map(mapMembership));
	} catch (error) {
		console.error('organizations.getMembers:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.addMember = async (req, res) => {
	try {
		const organizationId = req.params.orgId;
		const canManage = await canManageOrganizationMembers(organizationId, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}

		const parsed = addMemberSchema.safeParse(req.body || {});
		if (!parsed.success) {
			return res.status(400).json({
				message: 'Payload membre invalide.',
				errors: parsed.error.flatten(),
			});
		}

		const targetUser = await resolveUserByIdOrEmail(parsed.data);
		if (!targetUser) {
			return res.status(404).json({ message: 'Utilisateur introuvable.' });
		}

		const existing = await OrganizationMember.findOne({
			organizationId,
			userId: targetUser._id,
		}).lean();
		if (existing) {
			return res.status(409).json({ message: 'Utilisateur déjà membre.' });
		}

		const currentAdmins = await OrganizationMember.countDocuments({
			organizationId,
			role: { $in: ['owner', 'admin'] },
		});
		const nextAdmins =
			parsed.data.role === 'admin' ? currentAdmins + 1 : currentAdmins;
		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.MANAGE_ADMINS,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
			usage: { adminsPeak: nextAdmins },
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}

		const created = await OrganizationMember.create({
			organizationId,
			userId: targetUser._id,
			role: parsed.data.role,
			addedByUserId: req.userId,
		});

		await syncAdminsPeak({
			organizationId,
			adminsCount: nextAdmins,
			idempotencyKey: `admin-peak:add:${organizationId}:${created._id}:${randomUUID()}`,
		});

		const populated = await OrganizationMember.findById(created._id)
			.populate('userId', '_id pseudo email name picture role')
			.lean();
		emitOrganizationMembershipUpdate(req.app.get('io'), {
			organizationId,
			reason: 'member_added',
			actorUserId: req.userId,
			affectedUserId: targetUser._id,
			affectedRole: created.role,
			occurredAt: new Date(),
		});
		return res.status(201).json(mapMembership(populated));
	} catch (error) {
		console.error('organizations.addMember:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.updateMember = async (req, res) => {
	try {
		const organizationId = req.params.orgId;
		const memberId = req.params.memberId;
		const canManage = await canManageOrganizationMembers(organizationId, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}

		const parsed = updateMemberSchema.safeParse(req.body || {});
		if (!parsed.success) {
			return res.status(400).json({
				message: 'Payload role invalide.',
				errors: parsed.error.flatten(),
			});
		}

		const member = await OrganizationMember.findOne({
			_id: memberId,
			organizationId,
		});
		if (!member) {
			return res.status(404).json({ message: 'Membre introuvable.' });
		}
		const previousRole = String(member.role || '').trim();

		if (member.role === 'owner' && parsed.data.role !== 'owner') {
			return res.status(400).json({
				message: 'Impossible de rétrograder le propriétaire.',
			});
		}

		const currentAdmins = await OrganizationMember.countDocuments({
			organizationId,
			role: { $in: ['owner', 'admin'] },
		});
		const nextAdmins =
			member.role !== 'admin' && parsed.data.role === 'admin' ?
				currentAdmins + 1
			:	member.role === 'admin' && parsed.data.role === 'member' ?
				Math.max(1, currentAdmins - 1)
			:	currentAdmins;

		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.MANAGE_ADMINS,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
			usage: { adminsPeak: nextAdmins },
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}

		member.role = parsed.data.role;
		await member.save();

		await syncAdminsPeak({
			organizationId,
			adminsCount: nextAdmins,
			idempotencyKey: `admin-peak:update:${organizationId}:${member._id}:${randomUUID()}`,
		});

		const populated = await OrganizationMember.findById(member._id)
			.populate('userId', '_id pseudo email name picture role')
			.lean();
		emitOrganizationMembershipUpdate(req.app.get('io'), {
			organizationId,
			reason: 'member_role_updated',
			actorUserId: req.userId,
			affectedUserId: member.userId,
			affectedRole: member.role,
			previousRole,
			occurredAt: new Date(),
		});
		return res.status(200).json(mapMembership(populated));
	} catch (error) {
		console.error('organizations.updateMember:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.deleteMember = async (req, res) => {
	try {
		const organizationId = req.params.orgId;
		const memberId = req.params.memberId;
		const canManage = await canManageOrganizationMembers(organizationId, req.userId);
		if (!canManage) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}

		const member = await OrganizationMember.findOne({
			_id: memberId,
			organizationId,
		});
		if (!member) {
			return res.status(404).json({ message: 'Membre introuvable.' });
		}
		if (member.role === 'owner') {
			return res.status(400).json({
				message: 'Suppression du propriétaire impossible.',
			});
		}
		const removedUserId = member.userId;
		const removedRole = member.role;

		await OrganizationMember.deleteOne({ _id: member._id });

		const currentAdmins = await OrganizationMember.countDocuments({
			organizationId,
			role: { $in: ['owner', 'admin'] },
		});
		await syncAdminsPeak({
			organizationId,
			adminsCount: currentAdmins,
			idempotencyKey: `admin-peak:delete:${organizationId}:${member._id}:${randomUUID()}`,
		});
		emitOrganizationMembershipUpdate(req.app.get('io'), {
			organizationId,
			reason: 'member_removed',
			actorUserId: req.userId,
			affectedUserId: removedUserId,
			affectedRole: removedRole,
			occurredAt: new Date(),
		});

		return res.status(204).send();
	} catch (error) {
		console.error('organizations.deleteMember:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.setActiveOrganization = async (req, res) => {
	try {
		const orgId = req.params.orgId;
		const organization = await Organization.findById(orgId).lean();
		if (!organization) {
			return res.status(404).json({ message: 'Organisation introuvable.' });
		}
		const membership = await OrganizationMember.findOne({
			organizationId: orgId,
			userId: req.userId,
		})
			.select('_id')
			.lean();
		if (!membership) {
			return res.status(403).json({ message: 'Accès refusé.' });
		}

		await User.updateOne(
			{ _id: req.userId },
			{ $set: { defaultOrganizationId: organization._id } },
		);
		return res.status(200).json({ activeOrganizationId: String(organization._id) });
	} catch (error) {
		console.error('organizations.setActiveOrganization:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
