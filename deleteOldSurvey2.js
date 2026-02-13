/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const Survey2 = require('./models/Survey_2'); // Vérifie que le chemin est correct

const deleteAllSurvey2 = async () => {
	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		console.log('Connecté à MongoDB');

		// Suppression de tous les documents de la collection "survey_2"
		const result = await Survey2.deleteMany({});
		console.log(`${result.deletedCount} survey(s) (version 2) supprimé(s)`);

		// Déconnexion
		await mongoose.disconnect();
		console.log('Déconnecté de MongoDB');
	} catch (error) {
		console.error(
			'Erreur lors de la suppression des surveys (version 2) :',
			error,
		);
		process.exit(1);
	}
};

// Exécution
deleteAllSurvey2();
