/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const Organization = require('../models/Organization');
const OrganizationMember = require('../models/OrganizationMember');

const shouldExecute = process.argv.includes('--execute');

const run = async () => {
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

	const ownerMemberships = await OrganizationMember.find({ role: 'owner' })
		.select('_id organizationId userId role')
		.lean();
	const organizationIds = [
		...new Set(ownerMemberships.map((entry) => String(entry.organizationId || '')).filter(Boolean)),
	];
	const organizations = await Organization.find({ _id: { $in: organizationIds } })
		.select('_id ownerUserId name')
		.lean();
	const organizationsById = new Map(
		organizations.map((organization) => [String(organization._id), organization]),
	);

	const invalidMemberships = ownerMemberships.filter((membership) => {
		const organization = organizationsById.get(String(membership.organizationId || ''));
		if (!organization?.ownerUserId) return true;
		return String(organization.ownerUserId) !== String(membership.userId);
	});

	console.log(
		JSON.stringify(
			{
				execute: shouldExecute,
				totalOwnerMemberships: ownerMemberships.length,
				invalidOwnerMemberships: invalidMemberships.length,
				sample: invalidMemberships.slice(0, 20).map((membership) => {
					const organization = organizationsById.get(String(membership.organizationId || ''));
					return {
						membershipId: String(membership._id),
						organizationId: String(membership.organizationId),
						organizationName: organization?.name || null,
						memberUserId: String(membership.userId),
						organizationOwnerUserId:
							organization?.ownerUserId ? String(organization.ownerUserId) : null,
					};
				}),
			},
			null,
			2,
		),
	);

	if (shouldExecute && invalidMemberships.length > 0) {
		const invalidIds = invalidMemberships.map((entry) => entry._id);
		const result = await OrganizationMember.deleteMany({ _id: { $in: invalidIds } });
		console.log(`Deleted invalid owner memberships: ${Number(result.deletedCount || 0)}`);
	}

	await mongoose.disconnect();
	console.log('Done.');
};

run().catch(async (error) => {
	console.error('Repair failed:', error);
	try {
		await mongoose.disconnect();
	} catch (_disconnectError) {
		// noop
	}
	process.exit(1);
});

