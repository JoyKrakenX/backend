/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const {
	validateCreateBinarySurvey,
	validateBinaryVote,
} = require('../middlewares/requestValidators');

const surveyCtrl = require('../controllers/survey');

router.post(
	'/',
	sensitiveRateLimit,
	auth,
	validateCreateBinarySurvey,
	surveyCtrl.createSurvey,
);

router.get('/:id', auth, surveyCtrl.getOneSurvey);

router.get('/:id/state', auth, surveyCtrl.getState);

router.get('/:id/results', auth, surveyCtrl.getFlashStats);

router.get('/:id/detailed-results', auth, surveyCtrl.getDetailedStats);

router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateBinaryVote,
	surveyCtrl.submitOpinion,
);

router.patch('/:id/close', sensitiveRateLimit, auth, surveyCtrl.closeSurvey);

module.exports = router;
