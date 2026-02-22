/** @format */

const Opinion = require('../models/Opinion');

const emitClassicReaction = (req, opinion) => {
	const io = req.app.get('io');
	if (!io || !opinion?.surveyId) return;

	io.to(`classic-binary-${opinion.surveyId}`).emit('classic:reaction', {
		surveyId: String(opinion.surveyId),
		type: 'binary',
		opinionId: String(opinion._id),
		likeCount: opinion.likes.length,
		dislikeCount: opinion.dislikes.length,
	});
};

exports.toggleLike = async (req, res, next) => {
	try {
		const opinion = await Opinion.findById(req.params.id);
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
		emitClassicReaction(req, opinion);

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
		const opinion = await Opinion.findById(req.params.id);
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
		emitClassicReaction(req, opinion);

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
