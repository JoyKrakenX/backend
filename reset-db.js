/** @format */

const mongoose = require('mongoose');
require('dotenv').config();

async function resetDatabase() {
	console.log('🔄 Réinitialisation de la base de données...');

	try {
		await mongoose.connect(process.env.MONGO_URI);
		console.log('✅ Connecté à MongoDB');

		const db = mongoose.connection.db;

		// Supprimer uniquement la collection opinions
		await db
			.collection('opinions')
			.drop()
			.catch(() => {
				console.log('ℹ️ Collection opinions déjà supprimée ou inexistante');
			});

		console.log('✅ Collection opinions supprimée');
		console.log('\n🎉 Base réinitialisée !');
		console.log('📌 Redémarrez votre serveur et testez à nouveau.');
	} catch (error) {
		console.error('❌ Erreur:', error.message);
	} finally {
		await mongoose.connection.close();
	}
}

resetDatabase();
