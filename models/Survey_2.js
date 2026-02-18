/** @format */

const mongoose = require('mongoose');
const {
	MIN_MULTIPLE_OPTIONS,
	MAX_MULTIPLE_OPTIONS,
} = require('../utils/multipleSurveyOptions');

const survey_2_Schema = mongoose.Schema({
	theme: { type: String, required: true, unique: true },
	contexte: { type: String },
	question: { type: String, required: true },
	explain: { type: Boolean, default: true },
	options: {
		type: [String],
		default: undefined,
		validate: {
			validator(value) {
				if (!Array.isArray(value) || value.length === 0) return true;
				return (
					value.length >= MIN_MULTIPLE_OPTIONS &&
					value.length <= MAX_MULTIPLE_OPTIONS
				);
			},
			message: `Le nombre d'options doit etre compris entre ${MIN_MULTIPLE_OPTIONS} et ${MAX_MULTIPLE_OPTIONS}.`,
		},
	},
	reponse_1: { type: String, default: null },
	reponse_2: { type: String, default: null },
	reponse_3: { type: String, default: null },
	reponse_4: { type: String, default: null },
	reponse_5: { type: String, default: null },
	reponse_6: { type: String, default: null },
	createdAt: { type: Date, default: Date.now },
	endedAt: { type: Date, default: null },
	userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
	isClosed: { type: Boolean, default: false },
});

module.exports = mongoose.model('Survey_2', survey_2_Schema);
