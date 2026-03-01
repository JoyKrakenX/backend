/** @format */

const mongoose = require('mongoose');

const SecurityAuditLog = require('../models/SecurityAuditLog');

const toObjectIdOrNull = (value) => {
	if (!value) return null;
	const normalized = String(value);
	if (!mongoose.Types.ObjectId.isValid(normalized)) return null;
	return mongoose.Types.ObjectId.createFromHexString(normalized);
};

const normalizeEmail = (value) => {
	const normalized = String(value || '').trim().toLowerCase();
	return normalized || null;
};

const logSecurityEvent = async (payload = {}) => {
	try {
		await SecurityAuditLog.create({
			event: String(payload.event || 'security_event'),
			level: ['info', 'warning', 'error'].includes(String(payload.level || ''))
				? String(payload.level)
				: 'warning',
			action: payload.action ? String(payload.action) : null,
			code: payload.code ? String(payload.code) : null,
			message: payload.message ? String(payload.message) : null,
			organizationId: toObjectIdOrNull(payload.organizationId),
			userId: toObjectIdOrNull(payload.userId),
			userEmail: normalizeEmail(payload.userEmail),
			requestId: payload.requestId ? String(payload.requestId) : null,
			ip: payload.ip ? String(payload.ip) : null,
			userAgent: payload.userAgent ? String(payload.userAgent) : null,
			meta: payload.meta || null,
		});
	} catch (error) {
		console.error('securityAudit log failed:', error?.message || error);
	}
};

module.exports = {
	logSecurityEvent,
};
