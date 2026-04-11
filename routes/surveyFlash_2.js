/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const { validateMultipleVote } = require('../middlewares/requestValidators');
const surveyFlash2Ctrl = require('../controllers/surveyFlash_2');

router.get('/:id/state', auth, surveyFlash2Ctrl.getState);
router.get('/:id/detailed-results', auth, surveyFlash2Ctrl.getDetailedResults);
router.get('/:id/integrity', sensitiveRateLimit, auth, surveyFlash2Ctrl.getIntegrity);
router.get('/:id/quarantine', sensitiveRateLimit, auth, surveyFlash2Ctrl.getQuarantineQueue);
router.post(
	'/:id/quarantine/:opinionId/review',
	sensitiveRateLimit,
	auth,
	surveyFlash2Ctrl.reviewQuarantineOpinion,
);
router.post(
	'/:id/comments/:opinionId/delete',
	sensitiveRateLimit,
	auth,
	surveyFlash2Ctrl.deleteComment,
);
router.post(
	'/:id/comments/:opinionId/restore',
	sensitiveRateLimit,
	auth,
	surveyFlash2Ctrl.restoreComment,
);
router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateMultipleVote,
	surveyFlash2Ctrl.submitOpinion,
);

module.exports = router;
