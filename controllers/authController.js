/** @format */

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const {
	ensurePersonalOrganizationForUser,
} = require('../services/organizationService');
const { resolveEffectiveRoleByEmail } = require('../utils/effectiveRoleResolver');

exports.updatePseudo = async (req, res) => {
  try {
    const userId = req.userId;
    const pseudo = String(req.body?.pseudo || '').trim();

    if (!pseudo || pseudo.length < 3 || pseudo.length > 32) {
      return res.status(400).json({ message: 'Pseudo invalide.' });
    }

    const existing = await User.findOne({ pseudo });
    if (existing && String(existing._id) !== String(userId)) {
      return res.status(409).json({ message: 'Ce pseudo est déjà utilisé.' });
    }

    const user = await User.findByIdAndUpdate(userId, { pseudo }, { new: true });
    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    return res.json({ pseudo: user.pseudo });
  } catch (error) {
    console.error('Erreur updatePseudo:', error);
    return res.status(500).json({ message: 'Erreur serveur.' });
  }
};

exports.completeProfile = async (req, res) => {
  try {
    const { tempToken, pseudo, birthdate, gender } = req.body || {};

    if (!tempToken) {
      return res.status(400).json({ message: 'Token non fourni.' });
    }

    if (!pseudo || !birthdate || !gender) {
      return res.status(400).json({ message: 'Tous les champs sont requis.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(String(tempToken), process.env.JWT_TEMP_SECRET);
    } catch (_error) {
      return res.status(401).json({ message: 'Token temporaire invalide ou expiré.' });
    }

    const user =
      (await User.findById(decoded.userId)) ||
      (await User.findOne({ googleId: decoded.googleId }));

    if (!user) {
      return res.status(404).json({ message: 'Utilisateur introuvable.' });
    }

    const normalizedPseudo = String(pseudo || '').trim();
    const exists = await User.findOne({ pseudo: normalizedPseudo });
    if (exists && String(exists._id) !== String(user._id)) {
      return res.status(409).json({ message: 'Ce pseudo est déjà utilisé.' });
    }

    user.pseudo = normalizedPseudo;
    user.birthdate = birthdate;
    user.gender = gender;
    await user.save();
    await ensurePersonalOrganizationForUser(user);
    const effectiveRole = resolveEffectiveRoleByEmail({
      email: user.email,
      fallbackRole: user.role || 'user',
    });

    const token = jwt.sign(
      {
        id: user._id,
        pseudo: user.pseudo,
        email: user.email,
        role: effectiveRole,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: process.env.JWT_EXPIRES_IN,
      },
    );

    return res.status(200).json({
      message: 'Profil complété avec succès.',
      token,
      user: {
        id: user._id,
        pseudo: user.pseudo,
        email: user.email,
        role: effectiveRole,
      },
    });
  } catch (error) {
    console.error('Erreur completeProfile:', error);
    return res.status(500).json({ message: 'Erreur interne du serveur.' });
  }
};
