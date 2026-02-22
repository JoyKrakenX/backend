/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');

const surveyCtrl = require('../controllers/survey');

router.post('/', auth, surveyCtrl.createSurvey);

router.get('/:id', auth, surveyCtrl.getOneSurvey);

router.get('/:id/state', auth, surveyCtrl.getState);

router.get('/:id/results', auth, surveyCtrl.getFlashStats);

router.get('/:id/detailed-results', auth, surveyCtrl.getDetailedStats);

router.post('/:id/answer', auth, surveyCtrl.submitOpinion);

router.patch('/:id/close', auth, surveyCtrl.closeSurvey);

module.exports = router;
