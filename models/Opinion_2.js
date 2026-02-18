/** @format */

const mongoose = require('mongoose');

const opinion_2_Schema = new mongoose.Schema({
	answer: {
		type: String,
		required: true,
		trim: true,
	},

	reason: { type: String, required: true, trim: true },

	surveyId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Survey_2',
		required: true,
	},

	userId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},

	userPseudo: {
		type: String,
		required: true,
	},

	createdAt: { type: Date, default: Date.now },

	likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

	dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

opinion_2_Schema.index(
	{ surveyId: 1, userId: 1 },
	{ unique: true, name: 'unique_opinion_per_user_per_survey' }
);

module.exports = mongoose.model('Opinion_2', opinion_2_Schema);
