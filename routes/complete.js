/** @format */

const express = require('express');

const router = express.Router();

const controller = require('../controllers/authController');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');

router.post('/complete-profile', sensitiveRateLimit, controller.completeProfile);

module.exports = router;
