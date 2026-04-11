/** @format */

const express = require('express');
const router = express.Router();
const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const {
	validateCreateMultipleSurvey,
	validateMultipleVote,
} = require('../middlewares/requestValidators');
const survey_2_Ctrl = require('../controllers/survey_2');

router.post(
	'/',
	sensitiveRateLimit,
	auth,
	validateCreateMultipleSurvey,
	survey_2_Ctrl.createSurvey,
);

router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateMultipleVote,
	survey_2_Ctrl.submitOpinion,
);

router.get('/:id/state', auth, survey_2_Ctrl.getState);

router.get('/:id/results', auth, survey_2_Ctrl.getFlashStats);

router.get('/:id/detailed-results', auth, survey_2_Ctrl.getDetailedStats);
router.get('/:id/integrity', sensitiveRateLimit, auth, survey_2_Ctrl.getIntegrity);
router.get('/:id/quarantine', sensitiveRateLimit, auth, survey_2_Ctrl.getQuarantineQueue);
router.post(
	'/:id/quarantine/:opinionId/review',
	sensitiveRateLimit,
	auth,
	survey_2_Ctrl.reviewQuarantineOpinion,
);
router.post(
	'/:id/comments/:opinionId/delete',
	sensitiveRateLimit,
	auth,
	survey_2_Ctrl.deleteComment,
);
router.post(
	'/:id/comments/:opinionId/restore',
	sensitiveRateLimit,
	auth,
	survey_2_Ctrl.restoreComment,
);

router.patch('/:id/close', sensitiveRateLimit, auth, survey_2_Ctrl.closeSurvey);

router.get('/:id', auth, survey_2_Ctrl.getOneSurvey);

module.exports = router;
