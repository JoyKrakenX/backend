/** @format */

const mongoose = require('mongoose');

const survey_2_Schema = mongoose.Schema({
	theme: { type: String, required: true, unique: true },
	contexte: { type: String },
	question: { type: String, required: true },
	reponse_1: { type: String, required: true },
	reponse_2: { type: String, required: true },
	reponse_3: { type: String, default: 'Autre point de vue' },
	createdAt: { type: Date, default: Date.now },
	endedAt: { type: Date, default: null },
	userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
	isClosed: { type: Boolean, default: false },
});

module.exports = mongoose.model('Survey_2', survey_2_Schema);
