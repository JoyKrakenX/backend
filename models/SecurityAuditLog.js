/** @format */

const mongoose = require('mongoose');

const securityAuditLogSchema = new mongoose.Schema(
	{
		event: { type: String, required: true, index: true },
		level: {
			type: String,
			enum: ['info', 'warning', 'error'],
			default: 'warning',
			index: true,
		},
		organizationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'Organization',
			default: null,
			index: true,
		},
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
			default: null,
			index: true,
		},
		userEmail: { type: String, default: null, index: true },
		action: { type: String, default: null, index: true },
		code: { type: String, default: null, index: true },
		message: { type: String, default: null },
		requestId: { type: String, default: null, index: true },
		ip: { type: String, default: null },
		userAgent: { type: String, default: null },
		meta: { type: mongoose.Schema.Types.Mixed, default: null },
	},
	{
		timestamps: true,
	},
);

securityAuditLogSchema.index({ createdAt: -1, event: 1, level: 1 });

module.exports = mongoose.model('SecurityAuditLog', securityAuditLogSchema);
