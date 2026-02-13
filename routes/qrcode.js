/** @format */

const express = require('express');
const router = express.Router();
const QRcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const mongoose = require('mongoose');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');

router.post('/generate', async (req, res) => {
	console.log('Requête QR reçue :', req.body);

	try {
		const { surveyId, type } = req.body;

		// -----------------------------
		// Validation de l'ID
		// -----------------------------
		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			console.log('ID invalide :', surveyId);
			return res.status(400).json({ message: 'ID invalide' });
		}

		// -----------------------------
		// Récupération du bon modèle
		// -----------------------------
		let survey;
		let targetUrl;

		// Frontend base URL (can be overridden with env FRONTEND_BASE_URL)
		const FRONTEND_BASE_URL =
			process.env.FRONTEND_BASE_URL || 'http://127.0.0.1:5500/frontend';

		if (type === 'binary') {
			survey = await Survey.findById(surveyId);
			// Use canonical public URL with id and type query params (scannable)
			targetUrl = `${FRONTEND_BASE_URL}/survey.html?id=${surveyId}&type=binary`;
		} else if (type === 'multiple') {
			survey = await Survey_2.findById(surveyId);
			// For multiple-choice, point to the choices page with id & type
			targetUrl = `${FRONTEND_BASE_URL}/survey-choices.html?id=${surveyId}&type=multiple`;
		} else {
			console.log('Type de sondage invalide :', type);
			return res.status(400).json({ message: 'Type de sondage invalide' });
		}

		if (!survey) {
			console.log('Sondage introuvable :', surveyId);
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const themeText = survey.theme;
		console.log('Thème du sondage :', themeText);

		// -----------------------------
		// Dossier de stockage
		// -----------------------------
		const dir = path.join(__dirname, '../uploads/qrcodes');
		if (!fs.existsSync(dir)) {
			console.log('Création du dossier :', dir);
			fs.mkdirSync(dir, { recursive: true });
		}

		const outputPath = path.join(dir, `survey-${surveyId}.png`);
		console.log('Chemin de sortie :', outputPath);

		// -----------------------------
		// Cache QR existant (sauf si force=true)
		// -----------------------------
		const force = !!req.body.force;
		if (!force && fs.existsSync(outputPath)) {
			console.log('QR existant trouvé, utilisation du cache');
			return res.status(200).json({
				message: 'QR code existant',
				qrPath: `/uploads/qrcodes/survey-${surveyId}.png`,
			});
		}
		if (force) console.log('Force regeneration requested, ignoring cache');

		// -----------------------------
		// Génération du QR code
		// -----------------------------
		console.log('Génération du nouveau QR...', 'targetUrl=', targetUrl);
		const qrWidth = 300;
		// Use high error correction so logos can be overlaid without breaking scannability
		const qrOptions = { width: qrWidth, errorCorrectionLevel: 'H', margin: 1 };
		let qrBuffer = await QRcode.toBuffer(targetUrl, qrOptions);
		console.log(
			'QR buffer generated (bytes):',
			qrBuffer.length,
			'options:',
			qrOptions
		);

		// -----------------------------
		// Ajouter un logo centré sur le QR si présent (./uploads/logo.png)
		// -----------------------------
		const defaultLogoPath = path.join(__dirname, '../uploads/logo.png');
		if (fs.existsSync(defaultLogoPath)) {
			try {
				// redimensionner le logo pour occuper ~22% du QR
				const logoSize = Math.floor(qrWidth * 0.18); // smaller logo to improve scannability
				const logoRaw = await sharp(defaultLogoPath)
					.resize(logoSize, logoSize, { fit: 'contain' })
					.png()
					.toBuffer();
				console.log(
					'Logo trouvé et redimensionné, buffer length:',
					logoRaw.length
				);

				// Créer un fond blanc (léger padding) pour améliorer la visibilité du logo
				const pad = Math.max(6, Math.floor(logoSize * 0.15));
				const bgSize = logoSize + pad * 2;
				const logoWithBg = await sharp({
					create: {
						width: bgSize,
						height: bgSize,
						channels: 4,
						background: '#ffffff',
					},
				})
					.composite([{ input: logoRaw, gravity: 'center' }])
					.png()
					.toBuffer();

				// Ecrire un fichier de debug pour vérifier le rendu du logo seul
				try {
					const debugLogoPath = path.join(dir, `debug-logo-${surveyId}.png`);
					await fs.promises.writeFile(debugLogoPath, logoWithBg);
					console.log('Logo avec fond écrit pour debug :', debugLogoPath);
				} catch (e) {
					console.warn('Impossible d’ecrire le fichier debug-logo:', e.message);
				}

				// Composite logoWithBg au centre du QR
				qrBuffer = await sharp(qrBuffer)
					.composite([{ input: logoWithBg, gravity: 'center', blend: 'over' }])
					.png()
					.toBuffer();
				console.log(
					'Logo appliqué au QR depuis',
					defaultLogoPath,
					'; QR buffer length after composite:',
					qrBuffer.length
				);
			} catch (e) {
				console.warn('Impossible d’appliquer le logo au QR:', e.message);
			}
		} else {
			console.log(
				'Aucun logo trouvé à',
				defaultLogoPath,
				'- génération sans logo'
			);
		}

		// -----------------------------
		// Génération du titre SVG adaptatif (multi-lignes + ajustement taille)
		// -----------------------------
		// Helpers pour wrapper le texte
		function wrapTextToLines(text, maxChars) {
			const words = text.split(/\s+/);
			const lines = [];
			let current = '';
			for (const w of words) {
				if (!current) current = w;
				else if ((current + ' ' + w).length <= maxChars) current += ' ' + w;
				else {
					lines.push(current);
					current = w;
				}
			}
			if (current) lines.push(current);
			return lines;
		}

		const canvasWidth = 400;
		const padding = 20;
		let fontSize = 28; // taille initiale
		let lines = [];
		let titleHeight = 0;
		for (; fontSize >= 12; fontSize -= 2) {
			const avgCharWidth = fontSize * 0.6; // approximation
			const maxCharsPerLine = Math.floor(
				(canvasWidth - padding * 2) / avgCharWidth
			);
			lines = wrapTextToLines(themeText, Math.max(10, maxCharsPerLine));
			if (lines.length <= 3) {
				titleHeight = lines.length * (fontSize + 6) + 20; // espace interne
				break;
			}
		}
		// cap la hauteur si trop grande
		titleHeight = Math.min(titleHeight, 120);

		// construire le SVG dynamiquement
		let svgLines = '';
		const startY = 30;
		for (let i = 0; i < lines.length; i++) {
			const y = startY + i * (fontSize + 6);
			svgLines += `<text x="${
				canvasWidth / 2
			}" y="${y}" font-size="${fontSize}" font-family="Arial" font-weight="bold" text-anchor="middle">${
				lines[i]
			}</text>`;
		}

		const underlineY = startY + lines.length * (fontSize + 6);
		const titleSvg = `<svg width="${canvasWidth}" height="${titleHeight}">${svgLines}<text x="${
			canvasWidth / 2
		}" y="${underlineY}" font-size="${Math.max(
			12,
			Math.floor(fontSize / 1.2)
		)}" font-family="Arial" text-anchor="middle">${'_'.repeat(
			24
		)}</text></svg>`;
		const titleBuffer = Buffer.from(titleSvg);

		// -----------------------------
		// Assemblage final avec sharp
		// -----------------------------
		const qrTop = titleHeight + 20;
		const canvasHeight = qrTop + qrWidth + 20;

		await sharp({
			create: {
				width: canvasWidth,
				height: canvasHeight,
				channels: 4,
				background: '#ffffff',
			},
		})
			.composite([
				{ input: titleBuffer, top: 0, left: 0 },
				{
					input: qrBuffer,
					top: qrTop,
					left: Math.floor((canvasWidth - qrWidth) / 2),
				},
			])
			.png()
			.toFile(outputPath);

		console.log('QR généré avec succès :', outputPath);

		// -----------------------------
		// Réponse frontend
		// -----------------------------
		return res.status(200).json({
			message: 'QR code généré avec succès',
			qrPath: `/uploads/qrcodes/survey-${surveyId}.png`,
		});
	} catch (error) {
		console.error('Erreur lors de la génération QR :', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
});

module.exports = router;
