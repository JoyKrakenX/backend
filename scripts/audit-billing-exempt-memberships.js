/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');
const { getConfiguredBillingExemptEmails } = require('../services/superAdminService');

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const formatRole = (role) => {
	const normalized = String(role || '').trim().toLowerCase();
	if (!normalized) return 'member';
	return normalized;
};

const run = async () => {
	if (!process.env.MONGO_URI) {
		throw new Error('MONGO_URI is missing in environment.');
	}

	const configuredEmails = [...getConfiguredBillingExemptEmails()]
		.map(normalizeEmail)
		.filter(Boolean);

	console.log('Starting billing-exempt membership audit (read-only).');
	console.log(
		`Configured billing-exempt emails: ${configuredEmails.length || 0}`,
	);

	if (!configuredEmails.length) {
		console.log('No billing-exempt emails configured. Nothing to audit.');
		return;
	}

	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

	const users = await User.find({
		email: { $in: configuredEmails },
	})
		.select('_id email role pseudo')
		.lean();

	if (!users.length) {
		console.log(
			'No user documents found for configured billing-exempt emails.',
		);
		await mongoose.disconnect();
		return;
	}

	let globalAnomalyCount = 0;

	for (const user of users) {
		const userId = String(user._id);
		const userEmail = normalizeEmail(user.email);
		const userRole = String(user.role || 'user');

		const [ownedOrganizations, memberships] = await Promise.all([
			Organization.find({ ownerUserId: user._id })
				.select('_id name ownerUserId')
				.lean(),
			OrganizationMember.find({ userId: user._id })
				.select('_id organizationId role createdAt updatedAt')
				.populate({
					path: 'organizationId',
					select: '_id name ownerUserId',
				})
				.lean(),
		]);

		const ownedOrgIds = new Set(
			ownedOrganizations.map((organization) => String(organization._id)),
		);

		const ownedMemberships = [];
		const nonOwnedMemberships = [];

		for (const membership of memberships) {
			const org = membership.organizationId || null;
			const orgId = String(org?._id || membership.organizationId || '');
			const ownerUserId = String(org?.ownerUserId || '');
			const isOwned = ownedOrgIds.has(orgId) || ownerUserId === userId;
			const row = {
				membershipId: String(membership._id),
				organizationId: orgId,
				organizationName: String(org?.name || 'Unknown organization'),
				role: formatRole(membership.role),
			};
			if (isOwned) {
				ownedMemberships.push(row);
			} else {
				nonOwnedMemberships.push(row);
			}
		}

		globalAnomalyCount += nonOwnedMemberships.length;

		console.log('---');
		console.log(`User: ${userEmail}`);
		console.log(` - id: ${userId}`);
		console.log(` - globalRole: ${userRole}`);
		console.log(` - ownedOrganizations: ${ownedOrganizations.length}`);
		console.log(` - memberships: ${memberships.length}`);
		console.log(` - ownedMemberships: ${ownedMemberships.length}`);
		console.log(` - nonOwnedMemberships: ${nonOwnedMemberships.length}`);

		if (ownedMemberships.length) {
			console.log(' - Owned memberships:');
			ownedMemberships.forEach((entry) => {
				console.log(
					`   * ${entry.organizationName} (${entry.organizationId}) role=${entry.role}`,
				);
			});
		}

		if (nonOwnedMemberships.length) {
			console.log(' - Non-owned membership anomalies:');
			nonOwnedMemberships.forEach((entry) => {
				console.log(
					`   * ${entry.organizationName} (${entry.organizationId}) role=${entry.role}`,
				);
			});
		}
	}

	console.log('---');
	console.log(`Audit completed. Total anomaly memberships: ${globalAnomalyCount}`);

	await mongoose.disconnect();
	console.log('Disconnected from MongoDB.');
};

run().catch(async (error) => {
	console.error('Audit failed:', error.message || error);
	try {
		await mongoose.disconnect();
	} catch (_error) {}
	process.exit(1);
});
