/** @format */

const express = require('express');
const publicController = require('../controllers/publicController');

const router = express.Router();

router.get('/platform-metrics', publicController.getPlatformMetrics);

module.exports = router;
