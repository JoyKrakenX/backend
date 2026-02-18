/** @format */

const express = require('express');
const auth = require('../middlewares/auth');
const privacySettingsController = require('../controllers/privacySettingsController');

const router = express.Router();

router.get('/settings', auth, privacySettingsController.getSettings);
router.put('/settings', auth, privacySettingsController.saveSettings);

module.exports = router;
