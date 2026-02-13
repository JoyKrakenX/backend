/** @format */

const mongoose = require('mongoose');

const surveySchema = mongoose.Schema({
	theme: { type: String, required: true, unique: true },
	contexte: { type: String },
	question: { type: String, required: true },
	createdAt: { type: Date, default: Date.now },
	userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
	isClosed: { type: Boolean, default: false },
	endedAt: { type: Date, default: null },
});

module.exports = mongoose.model('Survey', surveySchema);
