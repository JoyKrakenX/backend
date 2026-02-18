/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');
const opinionFlash2Ctrl = require('../controllers/opinionFlash_2');

router.post('/:id/like', auth, opinionFlash2Ctrl.toggleLike);
router.post('/:id/dislike', auth, opinionFlash2Ctrl.toggleDislike);

module.exports = router;
