/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const ChatMessage = require('./models/ChatMessage'); // Vérifie que le chemin est correct

const deleteAllChatMessages = async () => {
	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		console.log('Connecté à MongoDB');

		// Suppression de tous les documents de la collection "chatmessages"
		const result = await ChatMessage.deleteMany({});
		console.log(`${result.deletedCount} message(s) de chat supprimé(s)`);

		// Déconnexion
		await mongoose.disconnect();
		console.log('Déconnecté de MongoDB');
	} catch (error) {
		console.error(
			'Erreur lors de la suppression des messages de chat :',
			error,
		);
		process.exit(1);
	}
};

// Exécution
deleteAllChatMessages();
