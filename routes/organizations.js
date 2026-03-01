/** @format */

const express = require('express');

const requireAuth = require('../middlewares/requireAuth');
const activeOrganization = require('../middlewares/activeOrganization');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const organizationController = require('../controllers/organizationController');

const router = express.Router();

router.get('/mine', requireAuth, activeOrganization, organizationController.getMine);
router.patch(
	'/active/:orgId',
	requireAuth,
	sensitiveRateLimit,
	activeOrganization,
	organizationController.setActiveOrganization,
);
router.get('/:orgId/members', requireAuth, organizationController.getMembers);
router.post(
	'/:orgId/members',
	requireAuth,
	sensitiveRateLimit,
	organizationController.addMember,
);
router.patch(
	'/:orgId/members/:memberId',
	requireAuth,
	sensitiveRateLimit,
	organizationController.updateMember,
);
router.delete(
	'/:orgId/members/:memberId',
	requireAuth,
	sensitiveRateLimit,
	organizationController.deleteMember,
);

module.exports = router;
