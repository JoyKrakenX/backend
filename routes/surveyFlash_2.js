/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const { sensitiveRateLimit } = require('../middlewares/securityRateLimit');
const { validateMultipleVote } = require('../middlewares/requestValidators');
const surveyFlash2Ctrl = require('../controllers/surveyFlash_2');

router.get('/:id/state', auth, surveyFlash2Ctrl.getState);
router.get('/:id/detailed-results', auth, surveyFlash2Ctrl.getDetailedResults);
router.post(
	'/:id/answer',
	sensitiveRateLimit,
	auth,
	validateMultipleVote,
	surveyFlash2Ctrl.submitOpinion,
);

module.exports = router;
