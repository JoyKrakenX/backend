/** @format */

const express = require('express');

const auth = require('../middlewares/auth');
const activeOrganization = require('../middlewares/activeOrganization');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const exportController = require('../controllers/exportController');

const router = express.Router();

router.post(
	'/survey/:id',
	sensitiveRateLimit,
	auth,
	activeOrganization,
	exportController.requestSurveyExport,
);

module.exports = router;
