/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const Opinion = require('./models/Opinion'); // Assure-toi que le chemin est correct

const deleteAllOpinions = async () => {
	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
		});
		console.log('Connecté à MongoDB');

		// Suppression de tous les documents de la collection "opinions"
		const result = await Opinion.deleteMany({});
		console.log(`${result.deletedCount} opinion(s) supprimée(s)`);

		// Déconnexion
		await mongoose.disconnect();
		console.log('Déconnecté de MongoDB');
	} catch (error) {
		console.error('Erreur lors de la suppression des opinions :', error);
		process.exit(1);
	}
};

// Exécution
deleteAllOpinions();
