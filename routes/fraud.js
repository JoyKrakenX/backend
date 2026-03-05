/** @format */

const express = require('express');

const authOrTempProfileAuth = require('../middlewares/authOrTempProfileAuth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const fraudController = require('../controllers/fraudController');

const router = express.Router();

router.post(
	'/challenges/email/start',
	sensitiveRateLimit,
	authOrTempProfileAuth,
	fraudController.startEmailChallenge,
);
router.post(
	'/challenges/email/verify',
	sensitiveRateLimit,
	authOrTempProfileAuth,
	fraudController.verifyEmailChallenge,
);

module.exports = router;
