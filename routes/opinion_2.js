/** @format */

const express = require('express');

const router = express.Router();

const auth = require('../middlewares/auth');

const opinionCtrl = require('../controllers/opinion_2');

router.post('/:id/like', auth, opinionCtrl.toggleLike);

router.post('/:id/dislike', auth, opinionCtrl.toggleDislike);

module.exports = router;
