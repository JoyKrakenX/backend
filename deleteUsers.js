/** @format */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User'); // chemin vers ton modèle User

// Connexion à MongoDB
mongoose
	.connect(process.env.MONGO_URI)
	.then(() => console.log('Connexion à MongoDB réussie !'))
	.catch((err) => {
		console.error('Erreur lors de la connexion à MongoDB :', err);
		process.exit(1);
	});

// Supprimer tous les utilisateurs
async function deleteAllUsers() {
	try {
		const result = await User.deleteMany({});
		console.log(`Nombre d'utilisateurs supprimés : ${result.deletedCount}`);
	} catch (err) {
		console.error('Erreur lors de la suppression des utilisateurs :', err);
	} finally {
		mongoose.connection.close();
	}
}

deleteAllUsers();
