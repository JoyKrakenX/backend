/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const surveyFlashCtrl = require('../controllers/surveyFlash');

router.get('/:id/state', auth, surveyFlashCtrl.getState);
router.get('/:id/detailed-results', auth, surveyFlashCtrl.getDetailedResults);
router.post('/:id/answer', auth, surveyFlashCtrl.submitOpinion);

module.exports = router;
