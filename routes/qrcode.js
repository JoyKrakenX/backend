/** @format */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const mongoose = require('mongoose');
const path = require('path');
const QRcode = require('qrcode');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const { buildFrontendUrl } = require('../utils/publicUrls');

const router = express.Router();
const QR_LAYOUT_VERSION = 'layoutV4';

function resolveTargetPages(type, explain) {
	if (type === 'binary') {
		return {
			answer: explain ? 'survey.html' : 'survey-flash-binary.html',
			results: explain ? 'survey-results.html' : 'survey-results-admin.html',
		};
	}

	return {
		answer: explain ? 'survey-choices.html' : 'survey-flash-multiple.html',
		results:
			explain ? 'survey-choices-results.html' : 'survey-results-admin.html',
	};
}

function escapeXml(input) {
	return String(input || '')
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function buildCacheKey(targetUrl, type, explain) {
	const payload = `${targetUrl}|${type}|${explain ? 'classic' : 'flash'}|${QR_LAYOUT_VERSION}`;
	return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function cleanupOldQrFiles(dir, surveyId, activeFilename) {
	try {
		const prefix = `survey-${surveyId}-`;
		const files = fs.readdirSync(dir);
		files
			.filter(
				(file) =>
					file.startsWith(prefix) &&
					(file.endsWith('.svg') || file.endsWith('.png')) &&
					file !== activeFilename,
			)
			.forEach((file) => {
				try {
					fs.unlinkSync(path.join(dir, file));
				} catch (_error) {
					// Ignore cleanup failures.
				}
			});
	} catch (_error) {
		// Ignore cleanup failures.
	}
}

function parseSvgMarkup(svgMarkup) {
	const cleaned = String(svgMarkup || '')
		.replace(/<\?xml[\s\S]*?\?>/gi, '')
		.replace(/<!DOCTYPE[\s\S]*?>/gi, '')
		.trim();

	const match = cleaned.match(/<svg\b([^>]*)>([\s\S]*?)<\/svg>/i);
	if (!match) {
		return {
			viewBox: '0 0 300 300',
			content: cleaned,
		};
	}

	const attrs = match[1] || '';
	const content = match[2] || '';

	const viewBoxMatch = attrs.match(/viewBox\s*=\s*["']([^"']+)["']/i);
	const widthMatch = attrs.match(/width\s*=\s*["']([^"']+)["']/i);
	const heightMatch = attrs.match(/height\s*=\s*["']([^"']+)["']/i);

	let viewBox = viewBoxMatch?.[1] || '';

	if (!viewBox) {
		const width = Number.parseFloat(widthMatch?.[1] || '');
		const height = Number.parseFloat(heightMatch?.[1] || '');
		if (Number.isFinite(width) && Number.isFinite(height)) {
			viewBox = `0 0 ${width} ${height}`;
		}
	}

	return {
		viewBox: viewBox || '0 0 300 300',
		content,
	};
}

function wrapTextToLines(text, maxCharsPerLine) {
	const words = String(text || '').split(/\s+/).filter(Boolean);
	const lines = [];
	let current = '';

	for (const word of words) {
		if (!current) {
			current = word;
			continue;
		}
		if ((current + ' ' + word).length <= maxCharsPerLine) {
			current += ` ${word}`;
			continue;
		}
		lines.push(current);
		current = word;
	}

	if (current) lines.push(current);
	return lines.length ? lines : ['Sondage'];
}

function readLogoDataUri(logoPath) {
	if (!fs.existsSync(logoPath)) return null;
	const raw = fs.readFileSync(logoPath);
	const ext = path.extname(logoPath).toLowerCase();
	const mime =
		ext === '.svg' ? 'image/svg+xml'
		: ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
		: 'image/png';
	return `data:${mime};base64,${raw.toString('base64')}`;
}

function resolveLogoPath() {
	const candidates = [
		path.join(__dirname, '../uploads/logo.svg'),
		path.join(__dirname, '../uploads/logo.png'),
		path.join(__dirname, '../uploads/logo.jpg'),
		path.join(__dirname, '../uploads/logo.jpeg'),
		path.join(__dirname, '../../frontend/assets/logo.svg'),
		path.join(__dirname, '../../frontend/assets/logo.png'),
	];

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}

	return null;
}

router.post('/generate', async (req, res) => {
	try {
		const { surveyId, type } = req.body;
		const force = Boolean(req.body.force);

		if (!surveyId || !mongoose.Types.ObjectId.isValid(surveyId)) {
			return res.status(400).json({ message: 'ID invalide' });
		}

		if (type !== 'binary' && type !== 'multiple') {
			return res.status(400).json({ message: 'Type de sondage invalide' });
		}

		const survey =
			type === 'binary' ?
				await Survey.findById(surveyId).lean()
			: 	await Survey_2.findById(surveyId).lean();

		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable' });
		}

		const explain = survey.explain !== false;
		const pages = resolveTargetPages(type, explain);
		const answerQuery = { id: surveyId, type };
		const isFlashSurvey = explain === false;
		const resultsQuery =
			isFlashSurvey ?
				{ Id: surveyId, type, flash: 1 }
			: type === 'binary' ?
				{ id: surveyId, type }
			:	{ Id: surveyId, id: surveyId, type };

		const urls = {
			answer: buildFrontendUrl(req, pages.answer, answerQuery),
			results: buildFrontendUrl(req, pages.results, resultsQuery),
			dashboard: buildFrontendUrl(req, 'my-surveys.html'),
		};

		const targetUrl = urls.answer;
		const cacheKey = buildCacheKey(targetUrl, type, explain);

		const outputDir = path.join(__dirname, '../uploads/qrcodes');
		if (!fs.existsSync(outputDir)) {
			fs.mkdirSync(outputDir, { recursive: true });
		}

		const filename = `survey-${surveyId}-${cacheKey}.svg`;
		const outputPath = path.join(outputDir, filename);
		const qrPath = `/uploads/qrcodes/${filename}`;

		if (!force && fs.existsSync(outputPath)) {
			return res.status(200).json({
				message: 'QR code existant',
				qrPath,
				urls,
				meta: {
					explain,
					type,
					cacheKey,
					format: 'svg',
					mime: 'image/svg+xml',
				},
			});
		}

		cleanupOldQrFiles(outputDir, surveyId, filename);

		const qrSize = 320;
		const qrOptions = {
			type: 'svg',
			width: qrSize,
			errorCorrectionLevel: 'H',
			margin: 1,
			color: {
				dark: '#000000',
				light: '#ffffff',
			},
		};
		const qrSvgMarkup = await QRcode.toString(targetUrl, qrOptions);
		const qrSvgDataUri = `data:image/svg+xml;base64,${Buffer.from(
			qrSvgMarkup,
			'utf8',
		).toString('base64')}`;

		const title = escapeXml(survey.theme || 'Sondage');
		const canvasWidth = 440;
		const padding = 20;
		let fontSize = 28;
		let lines = [];
		let titleHeight = 0;

		for (; fontSize >= 12; fontSize -= 2) {
			const avgCharWidth = fontSize * 0.6;
			const maxCharsPerLine = Math.floor(
				(canvasWidth - padding * 2) / avgCharWidth,
			);
			lines = wrapTextToLines(title, Math.max(10, maxCharsPerLine));
			if (lines.length <= 3) {
				titleHeight = lines.length * (fontSize + 6) + 20;
				break;
			}
		}

		titleHeight = Math.min(titleHeight || 60, 120);
		const startY = 30;
		const qrX = Math.floor((canvasWidth - qrSize) / 2);
		const qrY = titleHeight + 20;
		const canvasHeight = qrY + qrSize + 20;

		let logoMarkup = '';
		const resolvedLogoPath = resolveLogoPath();
		const logoDataUri = resolvedLogoPath ? readLogoDataUri(resolvedLogoPath) : null;
		if (logoDataUri) {
			const logoSize = Math.floor(qrSize * 0.18);
			const pad = Math.max(6, Math.floor(logoSize * 0.15));
			const bgSize = logoSize + pad * 2;
			const bgX = Math.floor(qrX + qrSize / 2 - bgSize / 2);
			const bgY = Math.floor(qrY + qrSize / 2 - bgSize / 2);
			const logoX = bgX + pad;
			const logoY = bgY + pad;
			const radius = Math.max(4, Math.floor(bgSize * 0.12));
			logoMarkup = `
				<rect x="${bgX}" y="${bgY}" width="${bgSize}" height="${bgSize}" rx="${radius}" ry="${radius}" fill="#ffffff"/>
				<image href="${logoDataUri}" x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>
			`;
		}

		const titleLinesMarkup = lines
			.map((line, index) => {
				const y = startY + index * (fontSize + 6);
				return `<text x="${canvasWidth / 2}" y="${y}" font-size="${fontSize}" font-family="Arial" font-weight="700" text-anchor="middle" fill="#111827">${escapeXml(line)}</text>`;
			})
			.join('');

		const finalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="img" aria-label="QR code du sondage ${escapeXml(survey.theme || 'Sondage')}">
	<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#ffffff"/>
	${titleLinesMarkup}
	<rect x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" fill="#ffffff"/>
	<image href="${qrSvgDataUri}" x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"/>
	${logoMarkup}
</svg>`;

		fs.writeFileSync(outputPath, finalSvg, 'utf8');

		return res.status(200).json({
			message: 'QR code genere avec succes',
			qrPath,
			urls,
			meta: {
				explain,
				type,
				cacheKey,
				format: 'svg',
				mime: 'image/svg+xml',
			},
		});
	} catch (error) {
		console.error('Erreur lors de la generation QR :', error);
		return res.status(500).json({ message: 'Erreur serveur' });
	}
});

module.exports = router;
