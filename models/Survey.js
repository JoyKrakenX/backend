/** @format */

const mongoose = require('mongoose');
const {
	SURVEY_STATUS_ENUM,
	SURVEY_STATUS_PUBLIC,
} = require('../utils/surveyStatus');

const surveySchema = mongoose.Schema({
	theme: { type: String, required: true, unique: true },
	contexte: { type: String },
	question: { type: String, required: true },
	explain: { type: Boolean, default: true },
	status: {
		type: String,
		enum: SURVEY_STATUS_ENUM,
		default: SURVEY_STATUS_PUBLIC,
	},
	createdAt: { type: Date, default: Date.now },
	userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
	isClosed: { type: Boolean, default: false },
	endedAt: { type: Date, default: null },
});

module.exports = mongoose.model('Survey', surveySchema);
