/** @format */

const {
	resolveActiveOrganizationContext,
} = require('../services/organizationService');

module.exports = async (req, res, next) => {
	try {
		if (!req.userId) {
			return res.status(401).json({ message: 'Authentification requise.' });
		}

		const requestedOrgId =
			req.headers['x-organization-id'] ||
			req.headers['x-org-id'] ||
			req.query?.organizationId ||
			req.body?.organizationId ||
			null;

		const context = await resolveActiveOrganizationContext({
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
			requestedOrganizationId: requestedOrgId,
		});

		if (!context.ok) {
			return res.status(403).json({
				code: context.code,
				message: "Impossible de résoudre l'organisation active.",
			});
		}

		req.activeOrganization = context.organization;
		req.activeOrganizationId = context.organization?._id || null;
		req.activeOrganizationRole = context.role || null;
		req.isSuperAdmin = Boolean(context.isSuperAdmin);
		return next();
	} catch (error) {
		console.error('activeOrganization middleware error:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
