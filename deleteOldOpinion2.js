/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const Opinion2 = require('./models/Opinion_2'); // Vérifie que le chemin est correct

const deleteAllOpinion2 = async () => {
	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		console.log('Connecté à MongoDB');

		// Suppression de tous les documents de la collection "opinion_2"
		const result = await Opinion2.deleteMany({});
		console.log(`${result.deletedCount} opinion(s) (version 2) supprimée(s)`);

		// Déconnexion
		await mongoose.disconnect();
		console.log('Déconnecté de MongoDB');
	} catch (error) {
		console.error(
			'Erreur lors de la suppression des opinions (version 2) :',
			error,
		);
		process.exit(1);
	}
};

// Exécution
deleteAllOpinion2();
