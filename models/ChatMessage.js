/** @format */

const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
	surveyId: {
		type: mongoose.Schema.Types.ObjectId,
		required: true,
		refPath: 'surveyModel',
	},
	surveyModel: {
		type: String,
		required: true,
		enum: ['Survey', 'Survey_2'],
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
	message: {
		type: String,
		required: true,
		trim: true,
		maxlength: 500,
	},
	isSystemMessage: {
		type: Boolean,
		default: false,
	},
	// Nouveau champ pour la réponse à un message
	replyTo: {
		type: mongoose.Schema.Types.ObjectId,
		ref: 'ChatMessage',
		default: null,
	},
	// Nouveau champ pour stocker les infos du message original
	replyToInfo: {
		type: {
			messageId: mongoose.Schema.Types.ObjectId,
			userId: mongoose.Schema.Types.ObjectId,
			pseudo: String,
			message: String,
		},
		default: null,
	},
	createdAt: {
		type: Date,
		default: Date.now,
	},
	likes: [
		{
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
		},
	],
	dislikes: [
		{
			type: mongoose.Schema.Types.ObjectId,
			ref: 'User',
		},
	],
});

// Index pour les performances
chatMessageSchema.index(
	{ surveyId: 1, surveyModel: 1, createdAt: -1 },
	{ name: 'surveyId_surveyModel_createdAt' },
);
chatMessageSchema.index({ userId: 1 });
chatMessageSchema.index({ createdAt: -1 });
chatMessageSchema.index({ replyTo: 1 }); // Nouvel index pour optimiser les recherches de réponses

// Méthode pour formater le message
chatMessageSchema.methods.toJSON = function () {
	const message = this.toObject();
	message.id = message._id;
	delete message._id;
	delete message.__v;
	return message;
};

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
