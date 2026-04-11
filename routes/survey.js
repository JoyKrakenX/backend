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
router.get('/:id/integrity', sensitiveRateLimit, auth, surveyCtrl.getIntegrity);
router.get('/:id/quarantine', sensitiveRateLimit, auth, surveyCtrl.getQuarantineQueue);
router.post(
	'/:id/quarantine/:opinionId/review',
	sensitiveRateLimit,
	auth,
	surveyCtrl.reviewQuarantineOpinion,
);
router.post(
	'/:id/comments/:opinionId/delete',
	sensitiveRateLimit,
	auth,
	surveyCtrl.deleteComment,
);
router.post(
	'/:id/comments/:opinionId/restore',
	sensitiveRateLimit,
	auth,
	surveyCtrl.restoreComment,
);

router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateBinaryVote,
	surveyCtrl.submitOpinion,
);

router.patch('/:id/close', sensitiveRateLimit, auth, surveyCtrl.closeSurvey);

module.exports = router;
