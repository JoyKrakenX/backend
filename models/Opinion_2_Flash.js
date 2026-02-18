/** @format */

const mongoose = require('mongoose');

const opinion2FlashSchema = new mongoose.Schema({
	answer: {
		type: String,
		required: true,
		trim: true,
	},

	reason: { type: String, trim: true },

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

	userPseudo: { type: String, required: true },

	createdAt: { type: Date, default: Date.now },

	likes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

	dislikes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
});

opinion2FlashSchema.index(
	{ surveyId: 1, userId: 1 },
	{
		unique: true,
		name: 'unique_flash_multiple_opinion_per_user_per_survey',
		background: true,
	},
);

opinion2FlashSchema.path('userId').index(false);

module.exports = mongoose.model('Opinion_2_Flash', opinion2FlashSchema);
