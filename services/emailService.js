/** @format */

const Mailjet = require('node-mailjet');

let mailjetClient = null;
const EMAIL_PROVIDER = 'mailjet';

const canSendEmails = () =>
	Boolean(
		process.env.MAILJET_API_KEY &&
			process.env.MAILJET_SECRET_KEY &&
			process.env.MAILJET_FROM_EMAIL,
	);

const createEmailServiceError = (message, code = 'EMAIL_SERVICE_ERROR', status = 500) => {
	const error = new Error(message);
	error.code = code;
	error.status = status;
	return error;
};

const getMailjetClient = () => {
	if (mailjetClient) return mailjetClient;
	if (!canSendEmails()) return null;

	mailjetClient = Mailjet.apiConnect(
		process.env.MAILJET_API_KEY,
		process.env.MAILJET_SECRET_KEY,
	);
	return mailjetClient;
};

const resolveFrom = (from) => {
	const fallbackEmail = String(process.env.MAILJET_FROM_EMAIL || '').trim();
	const fallbackName = String(process.env.MAILJET_FROM_NAME || 'Community').trim();
	const normalizedFrom = String(from || '').trim();

	if (!normalizedFrom) {
		return {
			Email: fallbackEmail,
			Name: fallbackName || fallbackEmail,
		};
	}

	const bracketMatch = normalizedFrom.match(/^(.*)<([^>]+)>$/);
	if (bracketMatch) {
		const name = String(bracketMatch[1] || '').trim();
		const email = String(bracketMatch[2] || '').trim();
		return {
			Email: email || fallbackEmail,
			Name: name || fallbackName || email || fallbackEmail,
		};
	}

	return {
		Email: normalizedFrom,
		Name: fallbackName || normalizedFrom,
	};
};

const resolveReplyTo = () => {
	const replyToEmail = String(
		process.env.MAILJET_REPLY_TO_EMAIL || process.env.SUPPORT_INBOX_EMAIL || '',
	).trim();
	if (!replyToEmail) return null;

	const replyToName = String(
		process.env.MAILJET_REPLY_TO_NAME ||
			process.env.SUPPORT_INBOX_NAME ||
			process.env.MAILJET_FROM_NAME ||
			'Community Support',
	).trim();

	return {
		Email: replyToEmail,
		Name: replyToName || replyToEmail,
	};
};

const sendEmail = async ({
	to,
	subject,
	html,
	text,
	from,
	headers,
	requireConfigured = false,
}) => {
	const activeClient = getMailjetClient();

	if (!activeClient) {
		if (requireConfigured) {
			console.warn(
				`[EmailService] provider=${EMAIL_PROVIDER} ready=false requireConfigured=true`,
			);
			throw createEmailServiceError(
				'Email service unavailable: missing Mailjet configuration.',
				'MAIL_PROVIDER_NOT_CONFIGURED',
				503,
			);
		}
		console.log('[Email disabled] Missing Mailjet env vars. Email payload:', {
			to,
			subject,
		});
		return { skipped: true };
	}

	const fromIdentity = resolveFrom(from);
	const textPart = String(text || '').trim();
	const htmlPart = String(html || '').trim();
	const normalizedHeaders =
		headers && typeof headers === 'object' && !Array.isArray(headers)
			? Object.entries(headers).reduce((acc, [key, value]) => {
					const headerKey = String(key || '').trim();
					const headerValue = String(value ?? '').trim();
					if (!headerKey || !headerValue) return acc;
					acc[headerKey] = headerValue;
					return acc;
			  }, {})
			: null;

	const message = {
		From: fromIdentity,
		To: [{ Email: String(to || '').trim() }],
		Subject: String(subject || '').trim(),
	};
	const replyToIdentity = resolveReplyTo();
	if (replyToIdentity) message.ReplyTo = replyToIdentity;
	if (textPart) message.TextPart = textPart;
	if (htmlPart) message.HTMLPart = htmlPart;
	if (normalizedHeaders && Object.keys(normalizedHeaders).length > 0) {
		message.Headers = normalizedHeaders;
	}

	try {
		const response = await activeClient
			.post('send', { version: 'v3.1' })
			.request({ Messages: [message] });
		return response?.body || { delivered: true };
	} catch (error) {
		const details =
			error?.response?.body || error?.ErrorMessage || error?.message || null;
		console.error('[EmailService] Mailjet send failed', {
			code: 'MAILJET_SEND_FAILED',
			status: 503,
			message: error?.message || 'Mailjet delivery failed',
			details,
		});
		const providerError = createEmailServiceError(
			'Mailjet delivery failed.',
			'MAILJET_SEND_FAILED',
			503,
		);
		providerError.cause = error;
		providerError.details = details;
		throw providerError;
	}
};

console.log(
	`[EmailService] provider=${EMAIL_PROVIDER} ready=${canSendEmails() ? 'true' : 'false'}`,
);

module.exports = {
	sendEmail,
	canSendEmails,
};
