/** @format */

const express = require('express');
const multer = require('multer');
const supportController = require('../controllers/supportController');
const requireAuth = require('../middlewares/requireAuth');
const requireRole = require('../middlewares/requireRole');
const requireSupportAdminEmail = require('../middlewares/requireSupportAdminEmail');
const rateLimit = require('../middlewares/simpleRateLimit');
const { ensureUploadsSubdir } = require('../utils/runtimePaths');

const router = express.Router();

const uploadDir = ensureUploadsSubdir('support');

const allowedMimeTypes = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'application/pdf',
	'text/plain',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
	dest: uploadDir,
	limits: { fileSize: 5 * 1024 * 1024 },
	fileFilter: (_req, file, cb) => {
		if (!allowedMimeTypes.has(file.mimetype)) {
			return cb(new Error('Type de fichier non autorisé.'));
		}
		return cb(null, true);
	},
});

router.post(
	'/tickets',
	rateLimit({ windowMs: 60_000, max: 20, keyPrefix: 'support-create-ticket' }),
	requireAuth,
	upload.single('attachment'),
	supportController.createTicket,
);

router.get(
	'/tickets',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportController.listTickets,
);

router.get(
	'/tickets/:id',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportController.getTicketById,
);

router.patch(
	'/tickets/:id/status',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportController.updateTicketStatus,
);

router.post(
	'/tickets/:id/reply',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportController.replyTicket,
);

router.get(
	'/tickets/:id/attachment',
	requireAuth,
	requireRole('support', 'admin'),
	requireSupportAdminEmail,
	supportController.supportAttachmentDownload,
);

module.exports = router;
