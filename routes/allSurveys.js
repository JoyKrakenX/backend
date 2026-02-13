/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');

const surveysCtrl = require('../controllers/allSurveys');

router.get('/', auth, surveysCtrl.getAllSurveys);

module.exports = router;
