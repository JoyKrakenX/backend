/** @format */

const mongoose = require('mongoose');

const opinionFlashSchema = new mongoose.Schema({
	answer: { type: Boolean, required: true },

	reason: { type: String, trim: true },

	surveyId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'Survey',
		required: true,
	},

	userId: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'User',
		required: true,
	},

	userPseudo: { type: String, required: true },

	createdAt: { type: Date, default: Date.now },

	likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
	dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

opinionFlashSchema.index(
	{ surveyId: 1, userId: 1 },
	{
		unique: true,
		name: 'unique_flash_opinion_per_user_per_survey',
		background: true,
	},
);

opinionFlashSchema.path('userId').index(false);

module.exports = mongoose.model('Opinion_Flash', opinionFlashSchema);
