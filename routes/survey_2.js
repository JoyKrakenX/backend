/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const survey_2_Ctrl = require('../controllers/survey_2');

router.post('/', auth, survey_2_Ctrl.createSurvey);

router.post('/:id/answer', auth, survey_2_Ctrl.submitOpinion);

router.get('/:id/results', auth, survey_2_Ctrl.getFlashStats);

router.get('/:id/detailed-results', auth, survey_2_Ctrl.getDetailedStats);

router.patch('/:id/close', auth, survey_2_Ctrl.closeSurvey);

router.get('/:id', auth, survey_2_Ctrl.getOneSurvey);

module.exports = router;
