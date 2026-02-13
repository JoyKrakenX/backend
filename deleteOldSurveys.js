/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const Survey = require('./models/Survey'); // Vérifie que le chemin est correct

const deleteAllSurveys = async () => {
	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		console.log('Connecté à MongoDB');

		// Suppression de tous les documents de la collection "surveys"
		const result = await Survey.deleteMany({});
		console.log(`${result.deletedCount} survey(s) supprimé(s)`);

		// Déconnexion
		await mongoose.disconnect();
		console.log('Déconnecté de MongoDB');
	} catch (error) {
		console.error('Erreur lors de la suppression des surveys :', error);
		process.exit(1);
	}
};

// Exécution
deleteAllSurveys();
