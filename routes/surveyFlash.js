/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const { validateBinaryVote } = require('../middlewares/requestValidators');
const surveyFlashCtrl = require('../controllers/surveyFlash');

router.get('/:id/state', auth, surveyFlashCtrl.getState);
router.get('/:id/detailed-results', auth, surveyFlashCtrl.getDetailedResults);
router.get('/:id/integrity', sensitiveRateLimit, auth, surveyFlashCtrl.getIntegrity);
router.get('/:id/quarantine', sensitiveRateLimit, auth, surveyFlashCtrl.getQuarantineQueue);
router.post(
	'/:id/quarantine/:opinionId/review',
	sensitiveRateLimit,
	auth,
	surveyFlashCtrl.reviewQuarantineOpinion,
);
router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateBinaryVote,
	surveyFlashCtrl.submitOpinion,
);

module.exports = router;
