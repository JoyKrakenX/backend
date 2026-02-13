/** @format */

const Opinion_2 = require('../models/Opinion_2');

exports.toggleLike = async (req, res, next) => {
	try {
		const opinion = await Opinion_2.findById(req.params.id);
		if (!opinion)
			return res.status(404).json({ message: 'Opinion non trouvée' });

		const userId = req.userId.toString();

		const liked = opinion.likes.some((id) => id.toString() === userId);
		const disliked = opinion.dislikes.some((id) => id.toString() === userId);

		if (liked) {
			opinion.likes = opinion.likes.filter((id) => id.toString() !== userId);
		} else {
			opinion.likes.push(userId);

			if (disliked) {
				opinion.dislikes = opinion.dislikes.filter(
					(id) => id.toString() !== userId
				);
			}
		}

		// Bonus : éviter doublons
		opinion.likes = [...new Set(opinion.likes.map((id) => id.toString()))];
		opinion.dislikes = [
			...new Set(opinion.dislikes.map((id) => id.toString())),
		];

		await opinion.save();

		res.json({
			likeCount: opinion.likes.length,
			dislikeCount: opinion.dislikes.length,
			userLiked: !liked,
			userDisliked: false,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};

exports.toggleDislike = async (req, res, next) => {
	try {
		const opinion = await Opinion_2.findById(req.params.id);
		if (!opinion)
			return res.status(404).json({ message: 'Opinion non trouvée' });

		const userId = req.userId.toString();

		const liked = opinion.likes.some((id) => id.toString() === userId);
		const disliked = opinion.dislikes.some((id) => id.toString() === userId);

		if (disliked) {
			opinion.dislikes = opinion.dislikes.filter(
				(id) => id.toString() !== userId
			);
		} else {
			opinion.dislikes.push(userId);

			if (liked) {
				opinion.likes = opinion.likes.filter((id) => id.toString() !== userId);
			}
		}

		// Bonus : éviter doublons
		opinion.likes = [...new Set(opinion.likes.map((id) => id.toString()))];
		opinion.dislikes = [
			...new Set(opinion.dislikes.map((id) => id.toString())),
		];

		await opinion.save();

		res.json({
			likeCount: opinion.likes.length,
			dislikeCount: opinion.dislikes.length,
			userLiked: false,
			userDisliked: !disliked,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: 'Erreur serveur' });
	}
};
