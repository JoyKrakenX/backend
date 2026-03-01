/** @format */

const mongoose = require('mongoose');

const organizationMemberSchema = new mongoose.Schema(
	{
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			required: true,
			index: true,
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			required: true,
			index: true,
		},
		role: {
			type: String,
			enum: ['owner', 'admin', 'member'],
			default: 'member',
			index: true,
		},
		addedByUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
		},
	},
	{
		timestamps: true,
	},
);

organizationMemberSchema.index(
	{ organizationId: 1, userId: 1 },
	{ unique: true, name: 'unique_organization_member' },
);

module.exports = mongoose.model('OrganizationMember', organizationMemberSchema);
