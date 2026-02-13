/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const mySurveysCtrl = require('../controllers/mySurveys');

router.get('/', auth, mySurveysCtrl.getMySurveys);

module.exports = router;
