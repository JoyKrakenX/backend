/** @format */

const mongoose = require('mongoose');
const {
	MIN_MULTIPLE_OPTIONS,
	MAX_MULTIPLE_OPTIONS,
} = require('../utils/multipleSurveyOptions');
const {
	SURVEY_STATUS_ENUM,
	SURVEY_STATUS_PUBLIC,
} = require('../utils/surveyStatus');

const survey_2_Schema = mongoose.Schema({
	theme: { type: String, required: true },
	contexte: { type: String },
	question: { type: String, required: true },
	explain: { type: Boolean, default: true },
	status: {
		type: String,
		enum: SURVEY_STATUS_ENUM,
		default: SURVEY_STATUS_PUBLIC,
	},
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
			message: `Le nombre d'options doit être compris entre ${MIN_MULTIPLE_OPTIONS} et ${MAX_MULTIPLE_OPTIONS}.`,
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
	organizationId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Organization',
		default: null,
		index: true,
	},
	isClosed: { type: Boolean, default: false },
});

survey_2_Schema.index(
	{ userId: 1, createdAt: -1 },
	{ name: 'userId_createdAt' },
);

module.exports = mongoose.model('Survey_2', survey_2_Schema);
