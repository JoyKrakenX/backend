/** @format */

const crypto = require('crypto');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const { sendEmail, canSendEmails } = require('../services/emailService');
const {
	buildNewsletterConfirmationEmail,
} = require('../services/newsletterEmailTemplate');

const DEFAULT_LOCALE = 'fr';
const SUPPORTED_LOCALES = new Set(['fr', 'en', 'es', 'de']);

const NEWSLETTER_RESEND_COOLDOWN_MS = 120000;
const NEWSLETTER_RESEND_WINDOW_MS = 1000 * 60 * 60 * 24;
const NEWSLETTER_RESEND_DAILY_CAP = 5;
const CONFIRM_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 3;

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const hashToken = (token) =>
	crypto.createHash('sha256').update(String(token)).digest('hex');
const createOpaqueToken = () => crypto.randomBytes(32).toString('hex');

const ensureValidLocale = (locale) => {
	const normalized = String(locale || '').trim().toLowerCase();
	return SUPPORTED_LOCALES.has(normalized) ? normalized : DEFAULT_LOCALE;
};

const resolveFrontendBase = () =>
	String(
		process.env.APP_PUBLIC_URL ||
			process.env.FRONTEND_URL ||
			process.env.API_PUBLIC_URL ||
			'',
	)
		.trim()
		.replace(/\/+$/, '');

const buildConfirmLink = (base, token) =>
	`${base}/newsletter-confirm.html?token=${encodeURIComponent(token)}`;

const buildUnsubscribeLink = (base, token) =>
	`${base}/newsletter-unsubscribe.html?token=${encodeURIComponent(token)}`;

const wantsHtmlResponse = (req) => {
	const requestedFormat = String(req.query?.format || '')
		.trim()
		.toLowerCase();
	if (requestedFormat === 'json') return false;

	const accept = String(req.headers?.accept || '')
		.trim()
		.toLowerCase();
	return (
		accept.includes('text/html') || accept.includes('application/xhtml+xml')
	);
};

const buildNewsletterStatusRedirectUrl = (pageName, status, message = '') => {
	const params = new URLSearchParams();
	if (status) params.set('status', status);
	if (message) params.set('message', message);

	const query = params.toString();
	const frontendBase = resolveFrontendBase();
	if (/^https?:\/\//i.test(frontendBase)) {
		return `${frontendBase}/${pageName}.html${query ? `?${query}` : ''}`;
	}
	return `/${pageName}.html${query ? `?${query}` : ''}`;
};

const redirectNewsletterStatus = (res, pageName, status, message = '') =>
	res.redirect(
		302,
		buildNewsletterStatusRedirectUrl(pageName, status, message),
	);

const hasPendingTokenStillValid = (subscriber) =>
	Boolean(
		subscriber?.status === 'pending' &&
			subscriber?.confirmTokenHash &&
			subscriber?.confirmTokenExpiresAt &&
			subscriber.confirmTokenExpiresAt > new Date(),
	);

const toSeconds = (milliseconds) =>
	Math.max(1, Math.ceil(Math.max(0, Number(milliseconds) || 0) / 1000));

const getAttemptWindowState = (subscriber, nowMs = Date.now()) => {
	const rawWindowStart = subscriber?.confirmEmailAttemptWindowStartAt
		? new Date(subscriber.confirmEmailAttemptWindowStartAt).getTime()
		: null;
	const hasWindow =
		Number.isFinite(rawWindowStart) &&
		rawWindowStart > 0 &&
		nowMs >= rawWindowStart &&
		nowMs - rawWindowStart < NEWSLETTER_RESEND_WINDOW_MS;

	const attemptCount = hasWindow
		? Math.max(0, Number(subscriber?.confirmEmailAttemptCount24h || 0))
		: 0;
	const windowStartAt = new Date(hasWindow ? rawWindowStart : nowMs);
	const retryAfterSeconds = hasWindow
		? toSeconds(NEWSLETTER_RESEND_WINDOW_MS - (nowMs - rawWindowStart))
		: toSeconds(NEWSLETTER_RESEND_WINDOW_MS);

	return { attemptCount, windowStartAt, retryAfterSeconds };
};

const getCooldownSeconds = (subscriber, nowMs = Date.now()) => {
	const lastSentMs = subscriber?.confirmEmailLastSentAt
		? new Date(subscriber.confirmEmailLastSentAt).getTime()
		: null;
	if (!Number.isFinite(lastSentMs) || lastSentMs <= 0 || nowMs < lastSentMs) {
		return 0;
	}
	const remaining = NEWSLETTER_RESEND_COOLDOWN_MS - (nowMs - lastSentMs);
	return remaining > 0 ? toSeconds(remaining) : 0;
};

const applySubscriberContext = (subscriber, { locale, sourcePage, req }) => {
	subscriber.locale = locale;
	subscriber.sourcePage = sourcePage;
	subscriber.userId = req.userId || subscriber.userId || null;
	subscriber.metadata = {
		ip: req.ip || subscriber.metadata?.ip || null,
		userAgent:
			String(req.headers?.['user-agent'] || subscriber.metadata?.userAgent || '') ||
			null,
	};
};

const createTokenSet = () => {
	const confirmToken = createOpaqueToken();
	const unsubscribeToken = createOpaqueToken();
	return {
		confirmToken,
		unsubscribeToken,
		confirmTokenHash: hashToken(confirmToken),
		unsubscribeTokenHash: hashToken(unsubscribeToken),
		confirmTokenExpiresAt: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS),
	};
};

const incrementAttemptState = (subscriber, nowDate) => {
	const nowMs = nowDate.getTime();
	const windowState = getAttemptWindowState(subscriber, nowMs);
	subscriber.confirmEmailAttemptWindowStartAt = windowState.windowStartAt;
	subscriber.confirmEmailAttemptCount24h = windowState.attemptCount + 1;
	subscriber.confirmEmailLastAttemptAt = nowDate;
};

const markSendSucceeded = (subscriber, nowDate) => {
	subscriber.confirmEmailLastSentAt = nowDate;
	subscriber.confirmEmailLastErrorCode = null;
};

const markSendFailed = (subscriber, errorCode) => {
	subscriber.confirmEmailLastErrorCode = String(
		errorCode || 'MAIL_DELIVERY_FAILED',
	).slice(0, 80);
};

const sendConfirmationEmail = async ({
	email,
	locale,
	confirmToken,
	unsubscribeToken,
	frontendBase,
}) => {
	const confirmLink = buildConfirmLink(frontendBase, confirmToken);
	const unsubscribeLink = buildUnsubscribeLink(frontendBase, unsubscribeToken);
	const template = buildNewsletterConfirmationEmail({
		locale,
		confirmLink,
		unsubscribeLink,
		frontendBase,
	});

	await sendEmail({
		to: email,
		subject: template.subject,
		text: template.text,
		html: template.html,
		headers: {
			'List-Unsubscribe': `<${unsubscribeLink}>`,
			'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
		},
		requireConfigured: true,
	});
};

const mapExistingSubscriberResponse = (subscriber) => {
	if (!subscriber) return null;
	if (subscriber.status === 'confirmed') {
		return {
			httpStatus: 200,
			status: 'already_subscribed',
			message: 'Cette adresse email est déjà inscrite à la newsletter.',
		};
	}
	if (hasPendingTokenStillValid(subscriber)) {
		return {
			httpStatus: 200,
			status: 'pending_exists',
			message:
				'Une confirmation est déjà en attente pour cette adresse. Vérifiez votre boîte email.',
		};
	}
	return null;
};

const toCsv = (rows) => {
	const headers = [
		'email',
		'status',
		'locale',
		'sourcePage',
		'confirmedAt',
		'unsubscribedAt',
		'createdAt',
	];
	const escape = (value) => {
		const text = String(value ?? '');
		const quoted = text.replace(/"/g, '""');
		return `"${quoted}"`;
	};

	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(
			[
				row.email,
				row.status,
				row.locale,
				row.sourcePage,
				row.confirmedAt ? new Date(row.confirmedAt).toISOString() : '',
				row.unsubscribedAt ? new Date(row.unsubscribedAt).toISOString() : '',
				row.createdAt ? new Date(row.createdAt).toISOString() : '',
			]
				.map(escape)
				.join(','),
		);
	}
	return lines.join('\n');
};

exports.subscribe = async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email);
		const locale = ensureValidLocale(req.body?.locale);
		const sourcePage = String(req.body?.sourcePage || 'unknown').slice(0, 80);
		const consent = Boolean(req.body?.consent);

		if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
			return res.status(400).json({ message: 'Adresse email invalide.' });
		}
		if (!consent) {
			return res
				.status(400)
				.json({ message: 'Le consentement est requis pour continuer.' });
		}
		if (!canSendEmails()) {
			return res.status(503).json({
				status: 'service_unavailable',
				message:
					"Le service email est indisponible pour le moment. Réessayez plus tard.",
			});
		}

		const frontendBase = resolveFrontendBase();
		if (!/^https?:\/\//i.test(frontendBase)) {
			return res.status(503).json({
				status: 'service_unavailable',
				message:
					'Configuration serveur incomplète pour les liens de confirmation newsletter.',
			});
		}

		const nowDate = new Date();
		let subscriber = await NewsletterSubscriber.findOne({ email });

		if (subscriber?.status === 'confirmed') {
			applySubscriberContext(subscriber, { locale, sourcePage, req });
			await subscriber.save();
			return res.status(200).json({
				status: 'already_subscribed',
				message: 'Cette adresse email est déjà inscrite à la newsletter.',
			});
		}

		if (!subscriber) {
			subscriber = new NewsletterSubscriber({ email });
		}
		applySubscriberContext(subscriber, { locale, sourcePage, req });

		if (subscriber.status === 'pending' && hasPendingTokenStillValid(subscriber)) {
			const windowState = getAttemptWindowState(subscriber, nowDate.getTime());
			if (windowState.attemptCount >= NEWSLETTER_RESEND_DAILY_CAP) {
				await subscriber.save();
				return res.status(200).json({
					status: 'pending_retry_later',
					retryAfterSeconds: windowState.retryAfterSeconds,
					message: `Trop de relances pour cette adresse. Réessayez dans ${windowState.retryAfterSeconds}s.`,
				});
			}

			const cooldownSeconds = getCooldownSeconds(subscriber, nowDate.getTime());
			if (cooldownSeconds > 0) {
				await subscriber.save();
				return res.status(200).json({
					status: 'pending_cooldown',
					cooldownSeconds,
					message: `Une confirmation est déjà en attente. Réessayez dans ${cooldownSeconds}s.`,
				});
			}

			const tokenSet = createTokenSet();
			subscriber.status = 'pending';
			subscriber.confirmTokenHash = tokenSet.confirmTokenHash;
			subscriber.confirmTokenExpiresAt = tokenSet.confirmTokenExpiresAt;
			subscriber.unsubscribeTokenHash = tokenSet.unsubscribeTokenHash;
			subscriber.unsubscribedAt = null;
			incrementAttemptState(subscriber, nowDate);
			await subscriber.save();

			try {
				await sendConfirmationEmail({
					email,
					locale,
					confirmToken: tokenSet.confirmToken,
					unsubscribeToken: tokenSet.unsubscribeToken,
					frontendBase,
				});
				markSendSucceeded(subscriber, new Date());
				await subscriber.save();
			} catch (error) {
				markSendFailed(subscriber, error?.code);
				await subscriber.save();
				throw error;
			}

			return res.status(202).json({
				status: 'pending_resent',
				message: 'Un nouvel email de confirmation a été envoyé.',
			});
		}

		const tokenSet = createTokenSet();
		subscriber.status = 'pending';
		subscriber.confirmTokenHash = tokenSet.confirmTokenHash;
		subscriber.confirmTokenExpiresAt = tokenSet.confirmTokenExpiresAt;
		subscriber.unsubscribeTokenHash = tokenSet.unsubscribeTokenHash;
		subscriber.unsubscribedAt = null;
		incrementAttemptState(subscriber, nowDate);
		await subscriber.save();

		try {
			await sendConfirmationEmail({
				email,
				locale,
				confirmToken: tokenSet.confirmToken,
				unsubscribeToken: tokenSet.unsubscribeToken,
				frontendBase,
			});
			markSendSucceeded(subscriber, new Date());
			await subscriber.save();
		} catch (error) {
			markSendFailed(subscriber, error?.code);
			await subscriber.save();
			throw error;
		}

		return res.status(202).json({
			status: 'pending',
			message:
				'Inscription enregistree. Verifiez votre email pour confirmer votre abonnement.',
		});
	} catch (error) {
		if (error?.code === 11000) {
			const email = normalizeEmail(req.body?.email);
			const existing = await NewsletterSubscriber.findOne({ email });
			const status = mapExistingSubscriberResponse(existing);
			if (status) {
				return res.status(status.httpStatus).json({
					status: status.status,
					message: status.message,
				});
			}
		}

		if (
			error?.code === 'MAIL_PROVIDER_NOT_CONFIGURED' ||
			error?.code === 'MAILJET_SEND_FAILED' ||
			error?.status === 503
		) {
			return res.status(503).json({
				status: 'service_unavailable',
				message:
					"Impossible d'envoyer l'email de confirmation pour le moment. Réessayez plus tard.",
			});
		}

		console.error('newsletter.subscribe:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.confirm = async (req, res) => {
	const respondAsHtml = wantsHtmlResponse(req);
	try {
		const token = String(req.query?.token || '').trim();
		if (!token) {
			const message = 'Token de confirmation manquant.';
			if (respondAsHtml) {
				return redirectNewsletterStatus(
					res,
					'newsletter-confirm',
					'missing_token',
					message,
				);
			}
			return res.status(400).json({ message });
		}

		const tokenHash = hashToken(token);
		const subscriber = await NewsletterSubscriber.findOne({
			confirmTokenHash: tokenHash,
			status: 'pending',
			confirmTokenExpiresAt: { $gt: new Date() },
		});

		if (!subscriber) {
			const message = 'Lien invalide ou expiré. Veuillez refaire une inscription.';
			if (respondAsHtml) {
				return redirectNewsletterStatus(
					res,
					'newsletter-confirm',
					'invalid_or_expired',
					message,
				);
			}
			return res.status(400).json({ message });
		}

		subscriber.status = 'confirmed';
		subscriber.confirmedAt = new Date();
		subscriber.confirmTokenHash = null;
		subscriber.confirmTokenExpiresAt = null;
		subscriber.confirmEmailLastErrorCode = null;
		await subscriber.save();

		const payload = {
			status: 'confirmed',
			message: 'Votre abonnement newsletter est confirmé.',
		};
		if (respondAsHtml) {
			return redirectNewsletterStatus(
				res,
				'newsletter-confirm',
				payload.status,
				payload.message,
			);
		}
		return res.status(200).json(payload);
	} catch (error) {
		console.error('newsletter.confirm:', error);
		if (respondAsHtml) {
			return redirectNewsletterStatus(
				res,
				'newsletter-confirm',
				'error',
				'Erreur serveur.',
			);
		}
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.unsubscribe = async (req, res) => {
	const respondAsHtml = wantsHtmlResponse(req);
	try {
		const rawToken = String(req.body?.token || req.query?.token || '').trim();
		const email = normalizeEmail(req.body?.email);
		let subscriber = null;

		if (rawToken) {
			subscriber = await NewsletterSubscriber.findOne({
				unsubscribeTokenHash: hashToken(rawToken),
			});
		} else if (email) {
			subscriber = await NewsletterSubscriber.findOne({ email });
		}

		if (!subscriber) {
			const message = 'Abonnement introuvable.';
			if (respondAsHtml) {
				return redirectNewsletterStatus(
					res,
					'newsletter-unsubscribe',
					'not_found',
					message,
				);
			}
			return res.status(404).json({ message });
		}

		subscriber.status = 'unsubscribed';
		subscriber.unsubscribedAt = new Date();
		await subscriber.save();

		const payload = {
			status: 'unsubscribed',
			message: 'Vous êtes désinscrit de la newsletter.',
		};
		if (respondAsHtml) {
			return redirectNewsletterStatus(
				res,
				'newsletter-unsubscribe',
				payload.status,
				payload.message,
			);
		}
		return res.status(200).json(payload);
	} catch (error) {
		console.error('newsletter.unsubscribe:', error);
		if (respondAsHtml) {
			return redirectNewsletterStatus(
				res,
				'newsletter-unsubscribe',
				'error',
				'Erreur serveur.',
			);
		}
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};

exports.adminExport = async (req, res) => {
	try {
		const format = String(req.query?.format || 'csv').toLowerCase();
		const rows = await NewsletterSubscriber.find({})
			.sort({ createdAt: -1 })
			.lean();

		if (format === 'json') {
			return res.status(200).json({ count: rows.length, subscribers: rows });
		}

		const csv = toCsv(rows);
		res.setHeader('Content-Type', 'text/csv; charset=utf-8');
		res.setHeader(
			'Content-Disposition',
			`attachment; filename="newsletter-subscribers-${Date.now()}.csv"`,
		);
		return res.status(200).send(csv);
	} catch (error) {
		console.error('newsletter.adminExport:', error);
		return res.status(500).json({ message: 'Erreur serveur.' });
	}
};
