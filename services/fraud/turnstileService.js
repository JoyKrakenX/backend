/** @format */

const { FRAUD_CONFIG } = require('../../utils/fraudConfig');

const TURNSTILE_VERIFY_URL =
	'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const verifyTurnstile = async ({ token, remoteIp }) => {
	if (!FRAUD_CONFIG.turnstileEnabled) {
		return {
			ok: true,
			skipped: true,
			reason: 'TURNSTILE_DISABLED',
		};
	}

	const secret = String(process.env.TURNSTILE_SECRET_KEY || '').trim();
	if (!secret) {
		return {
			ok: false,
			timeout: true,
			code: 'TURNSTILE_MISCONFIGURED',
			errorCodes: ['missing-input-secret'],
		};
	}

	if (!token) {
		return {
			ok: false,
			code: 'TURNSTILE_REQUIRED',
			errorCodes: ['missing-input-response'],
		};
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(
		() => controller.abort(),
		Math.max(300, Number(FRAUD_CONFIG.turnstileTimeoutMs || 1500)),
	);

	try {
		const form = new URLSearchParams();
		form.set('secret', secret);
		form.set('response', String(token));
		if (remoteIp) form.set('remoteip', String(remoteIp));

		const response = await fetch(TURNSTILE_VERIFY_URL, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: form,
			signal: controller.signal,
		});

		const payload = await response.json().catch(() => ({}));
		const success = Boolean(payload?.success);
		return {
			ok: success,
			code: success ? 'TURNSTILE_OK' : 'TURNSTILE_INVALID',
			errorCodes: Array.isArray(payload?.['error-codes'])
				? payload['error-codes']
				: [],
			challengeTs: payload?.challenge_ts || null,
			hostname: payload?.hostname || null,
		};
	} catch (error) {
		return {
			ok: false,
			timeout: true,
			code: 'TURNSTILE_TIMEOUT',
			errorCodes: [String(error?.name || 'turnstile_error')],
		};
	} finally {
		clearTimeout(timeoutId);
	}
};

module.exports = {
	verifyTurnstile,
};
