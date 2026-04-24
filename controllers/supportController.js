/** @format */

const path = require('path');
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const { sendEmail } = require('../services/emailService');

const CATEGORY_PRIORITY = {
	bug: 'high',
	technical: 'high',
	security: 'urgent',
	accessibility: 'high',
	legal: 'high',
	privacy: 'high',
	billing: 'normal',
	feature: 'normal',
	general: 'normal',
	other: 'low',
};

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value));

const sanitizeText = (value, max = 5000) =>
	String(value || '')
		.replace(/[<>]/g, '')
		.trim()
		.slice(0, max);

const buildTicketRef = () => {
	const year = new Date().getFullYear();
	const random = Math.floor(100000 + Math.random() * 900000);
	return `SUP-${year}-${random}`;
};

const resolvePriority = (category) =>
	CATEGORY_PRIORITY[String(category || '').toLowerCase()] || 'normal';

const summarizeEmailError = (error) => ({
	code: error?.code || 'EMAIL_SEND_FAILED',
	status: Number(error?.status || 503),
	message: String(error?.message || 'Email delivery failed'),
});

const buildTicketPayload = async (req) => {
	const authUser = req.userId ? await User.findById(req.userId).lean() : null;
	const input = req.body || {};

	const channelPage = sanitizeText(input.channelPage || 'contact', 32).toLowerCase();
	const category = sanitizeText(input.category || input.subject || 'general', 64).toLowerCase();
	const subject = sanitizeText(input.subject || 'Demande support', 180);
	const message = sanitizeText(input.message, 6000);
	const locale = sanitizeText(input.locale || 'fr', 8).toLowerCase();
	const name = sanitizeText(authUser?.pseudo || authUser?.name || input.name, 120);
	const email = sanitizeText(authUser?.email || input.email, 180).toLowerCase();

	if (!message || message.length < 10) {
		throw new Error('Message trop court.');
	}
	if (!name || name.length < 2) {
		throw new Error('Nom invalide.');
	}
	if (!email || !isValidEmail(email)) {
		throw new Error('Email invalide.');
	}

	const attachment = req.file
		? {
				path: req.file.path,
				originalName: req.file.originalname,
				mimeType: req.file.mimetype,
				size: req.file.size,
		  }
		: {
				path: null,
				originalName: null,
				mimeType: null,
				size: 0,
		  };

	return {
		ticketRef: buildTicketRef(),
		channelPage,
		category,
		subject,
		message,
		name,
		email,
		locale: ['fr', 'en', 'es', 'de'].includes(locale) ? locale : 'fr',
		userId: req.userId || null,
		attachment,
		priority: resolvePriority(category),
	};
};

const notifyTicketCreated = async (ticket) => {
	const supportInbox = String(process.env.SUPPORT_INBOX_EMAIL || '').trim();
	const delivery = {
		customer: 'pending',
		internal: supportInbox ? 'pending' : 'skipped',
		errors: [],
	};

	try {
		await sendEmail({
			to: ticket.email,
			subject: `Accuse de reception - ${ticket.ticketRef}`,
			text:
				`Bonjour ${ticket.name},\n\n` +
				`Votre demande (${ticket.ticketRef}) a bien ete recue.\n` +
				`Sujet: ${ticket.subject}\n\n` +
				`Notre equipe support reviendra vers vous rapidement.\n`,
			html:
				`<p>Bonjour ${ticket.name},</p>` +
				`<p>Votre demande <strong>${ticket.ticketRef}</strong> a bien ete recue.</p>` +
				`<p><strong>Sujet:</strong> ${ticket.subject}</p>` +
				`<p>Notre equipe support reviendra vers vous rapidement.</p>`,
			requireConfigured: true,
		});
		delivery.customer = 'sent';
	} catch (error) {
		delivery.customer = 'failed';
		delivery.errors.push({ target: 'customer', ...summarizeEmailError(error) });
	}

	if (supportInbox) {
		try {
			await sendEmail({
				to: supportInbox,
				subject: `Nouveau ticket support ${ticket.ticketRef}`,
				text:
					`Nouveau ticket recu\n` +
					`Reference: ${ticket.ticketRef}\n` +
					`Canal: ${ticket.channelPage}\n` +
					`Sujet: ${ticket.subject}\n` +
					`Email: ${ticket.email}\n`,
				html:
					`<p>Nouveau ticket recu</p>` +
					`<p><strong>Reference:</strong> ${ticket.ticketRef}</p>` +
					`<p><strong>Canal:</strong> ${ticket.channelPage}</p>` +
					`<p><strong>Sujet:</strong> ${ticket.subject}</p>` +
					`<p><strong>Email:</strong> ${ticket.email}</p>`,
				requireConfigured: true,
			});
			delivery.internal = 'sent';
		} catch (error) {
			delivery.internal = 'failed';
			delivery.errors.push({
				target: 'support_inbox',
				...summarizeEmailError(error),
			});
		}
	}

	return delivery;
};

exports.createTicket = async (req, res) => {
	try {
		const payload = await buildTicketPayload(req);

		let ticket = null;
		let attempts = 0;
		while (!ticket && attempts < 5) {
			attempts += 1;
			try {
				ticket = await SupportTicket.create(payload);
			} catch (error) {
				if (error.code === 11000 && error.keyPattern?.ticketRef) {
					payload.ticketRef = buildTicketRef();
					continue;
				}
				throw error;
			}
		}

		if (!ticket) {
			return res.status(503).json({
				message: 'Impossible de générer une référence de ticket. Réessayez.',
			});
		}

		const emailDelivery = await notifyTicketCreated(ticket);
		const response = {
			message: 'Ticket créé avec succès.',
			ticket: {
				id: ticket._id,
				ticketRef: ticket.ticketRef,
				status: ticket.status,
				priority: ticket.priority,
				createdAt: ticket.createdAt,
			},
			emailDelivery,
		};

		if (emailDelivery.errors.length) {
			response.warning =
				"Ticket créé, mais une ou plusieurs notifications email n'ont pas pu être envoyées.";
		}

		return res.status(201).json(response);
	} catch (error) {
		console.error('support.createTicket:', error);
		return res.status(400).json({
			message:
				error.message || 'Impossible de créer le ticket support pour le moment.',
		});
	}
};

exports.listTickets = async (req, res) => {
	try {
		const page = Math.max(1, Number(req.query?.page || 1));
		const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 20)));
		const skip = (page - 1) * limit;
		const filter = {};

		if (req.query?.status) filter.status = req.query.status;
		if (req.query?.priority) filter.priority = req.query.priority;
		if (req.query?.channelPage) filter.channelPage = req.query.channelPage;
		if (req.query?.category) filter.category = req.query.category;

		const [tickets, total] = await Promise.all([
			SupportTicket.find(filter)
				.sort({ createdAt: -1 })
				.skip(skip)
				.limit(limit)
				.populate('assignedTo', 'pseudo email role')
				.populate('userId', 'pseudo email role')
				.lean(),
			SupportTicket.countDocuments(filter),
		]);

		return res.status(200).json({
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
			tickets,
		});
	} catch (error) {
		console.error('support.listTickets:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.getTicketById = async (req, res) => {
	try {
		const ticket = await SupportTicket.findById(req.params.id)
			.populate('assignedTo', 'pseudo email role')
			.populate('userId', 'pseudo email role')
			.lean();

		if (!ticket) {
			return res.status(404).json({ message: 'Ticket introuvable.' });
		}

		return res.status(200).json({ ticket });
	} catch (error) {
		console.error('support.getTicketById:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.updateTicketStatus = async (req, res) => {
	try {
		const status = String(req.body?.status || '').trim();
		const allowed = new Set(['new', 'in_progress', 'resolved', 'closed']);
		if (!allowed.has(status)) {
			return res.status(400).json({ message: 'Statut invalide.' });
		}

		const updates = { status };
		if (status === 'resolved') {
			updates.resolvedAt = new Date();
		}
		if (status === 'in_progress' && req.userId) {
			updates.assignedTo = req.userId;
		}

		const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, updates, {
			new: true,
		});
		if (!ticket) {
			return res.status(404).json({ message: 'Ticket introuvable.' });
		}

		return res.status(200).json({
			message: 'Statut du ticket mis à jour.',
			ticket,
		});
	} catch (error) {
		console.error('support.updateTicketStatus:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.replyTicket = async (req, res) => {
	try {
		const message = sanitizeText(req.body?.message, 4000);
		if (!message || message.length < 2) {
			return res.status(400).json({ message: 'Message de réponse invalide.' });
		}

		const ticket = await SupportTicket.findById(req.params.id);
		if (!ticket) {
			return res.status(404).json({ message: 'Ticket introuvable.' });
		}

		const senderRole = req.userRole === 'admin' ? 'admin' : 'support';
		ticket.replies.push({
			senderRole,
			senderUserId: req.userId || null,
			message,
		});
		if (!ticket.firstResponseAt) ticket.firstResponseAt = new Date();
		if (ticket.status === 'new') ticket.status = 'in_progress';
		if (!ticket.assignedTo && req.userId) ticket.assignedTo = req.userId;
		await ticket.save();

		let emailDelivery = { customer: 'sent', error: null };
		try {
			await sendEmail({
				to: ticket.email,
				subject: `Mise a jour de votre ticket ${ticket.ticketRef}`,
				text:
					`Bonjour ${ticket.name},\n\n` +
					`Un agent a repondu a votre ticket ${ticket.ticketRef}.\n\n` +
					`${message}\n`,
				html:
					`<p>Bonjour ${ticket.name},</p>` +
					`<p>Un agent a repondu a votre ticket <strong>${ticket.ticketRef}</strong>.</p>` +
					`<p>${message}</p>`,
				requireConfigured: true,
			});
		} catch (error) {
			emailDelivery = {
				customer: 'failed',
				error: summarizeEmailError(error),
			};
		}

		const response = {
			message: 'Réponse enregistrée.',
			reply: ticket.replies[ticket.replies.length - 1],
			emailDelivery,
		};
		if (emailDelivery.customer === 'failed') {
			response.warning =
				'Reponse enregistree, mais la notification email au client a echoue.';
		}

		return res.status(200).json(response);
	} catch (error) {
		console.error('support.replyTicket:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.supportAttachmentDownload = async (req, res) => {
	try {
		const ticket = await SupportTicket.findById(req.params.id).lean();
		if (!ticket?.attachment?.path) {
			return res.status(404).json({ message: 'Pièce jointe introuvable.' });
		}
		return res.download(
			path.resolve(ticket.attachment.path),
			ticket.attachment.originalName || 'attachment',
		);
	} catch (error) {
		console.error('support.supportAttachmentDownload:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
