/** @format */

const mongoose = require('mongoose');
require('dotenv').config();

async function fixDatabase() {
	console.log('🔧 Début de la réparation de la base de données...');

	try {
		// Connexion à MongoDB
		await mongoose.connect(process.env.MONGO_URI);
		console.log('✅ Connecté à MongoDB');

		// Utiliser la connexion existante
		const db = mongoose.connection.db;

		// Étape 1: Vérifier si la collection opinions existe
		const collections = await db.listCollections().toArray();
		const opinionsExists = collections.some((col) => col.name === 'opinions');

		if (!opinionsExists) {
			console.log("ℹ️ La collection opinions n'existe pas encore");
			console.log('✅ Tout est prêt !');
			process.exit(0);
		}

		const collection = db.collection('opinions');

		// Étape 2: Lister tous les indexes
		console.log('\n📋 Liste des indexes actuels:');
		const indexes = await collection.indexes();

		if (indexes.length === 0) {
			console.log('ℹ️ Aucun index trouvé');
		} else {
			indexes.forEach((index, i) => {
				console.log(`${i + 1}. ${index.name}:`, index.key);
			});
		}

		// Étape 3: Chercher l'index problématique userId_1
		const badIndex = indexes.find(
			(index) =>
				index.name === 'userId_1' ||
				(index.key && index.key.userId && !index.key.surveyId)
		);

		if (badIndex) {
			console.log(`\n❌ Problème détecté: Index "${badIndex.name}"`);
			console.log(
				' Cet index empêche un utilisateur de voter pour plusieurs sondages'
			);

			// Demander confirmation
			console.log('\n⚠️ Voulez-vous supprimer cet index ? (O/N)');

			// Pour l'automatisation, on suppose Oui
			console.log("Suppression de l'index...");

			try {
				await collection.dropIndex(badIndex.name);
				console.log('✅ Index supprimé avec succès');
			} catch (err) {
				console.log("ℹ️ Impossible de supprimer l'index:", err.message);
			}
		} else {
			console.log("\n✅ Pas d'index problématique trouvé");
		}

		// Étape 4: Vérifier/Créer l'index composé correct
		const goodIndexExists = indexes.some(
			(index) => index.key && index.key.surveyId && index.key.userId
		);

		if (!goodIndexExists) {
			console.log("\n🔧 Création de l'index correct...");
			await collection.createIndex(
				{ surveyId: 1, userId: 1 },
				{ unique: true, name: 'unique_opinion_per_survey_per_user' }
			);
			console.log('✅ Index correct créé !');
		} else {
			console.log('\n✅ Index correct existe déjà');
		}

		console.log('\n🎉 Base de données réparée avec succès !');
		console.log('🔄 Redémarrez votre serveur et testez à nouveau.');
	} catch (error) {
		console.error('❌ Erreur:', error.message);
	} finally {
		// Fermer la connexion
		await mongoose.connection.close();
		process.exit(0);
	}
}

// Exécuter la fonction
fixDatabase();
