/** @format */

const express = require('express');

const router = express.Router();

const controller = require('../controllers/authController');

router.post('/complete-profile', controller.completeProfile);

module.exports = router;
