/** @format */

const mongoose = require('mongoose');

const opinionSchema = new mongoose.Schema({
	answer: { type: Boolean, required: true },

	reason: { type: String, required: true },

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

opinionSchema.index(
	{ surveyId: 1, userId: 1 },
	{
		unique: true,
		name: 'unique_opinion_per_user_per_survey',
		background: true, // Crée l'index en arrière-plan pour ne pas bloquer
	}
);

// Optionnel : Empêcher la création d'index automatique sur userId seul
opinionSchema.path('userId').index(false);

module.exports = mongoose.model('Opinion', opinionSchema);
