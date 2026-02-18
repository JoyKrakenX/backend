/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const opinionFlashCtrl = require('../controllers/opinionFlash');

router.post('/:id/like', auth, opinionFlashCtrl.toggleLike);
router.post('/:id/dislike', auth, opinionFlashCtrl.toggleDislike);

module.exports = router;
