/** @format */

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCALE = 'fr';
const SUPPORTED_LOCALES = new Set(['fr', 'en', 'es', 'de']);
const BRAND = Object.freeze({
	primary: '#6366f1',
	primaryDark: '#4f46e5',
	secondary: '#8b5cf6',
	ink: '#0f172a',
	muted: '#475569',
	panel: '#f8fafc',
	soft: '#eef2ff',
	border: '#e2e8f0',
});
const INLINE_LOGO_CONTENT_ID = 'community-logo';
const LOGO_PATH = path.join(__dirname, '../../frontend/assets/logo.png');

const escapeHtml = (value) =>
	String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

const normalizeLocale = (locale) => {
	const normalized = String(locale || '').trim().toLowerCase();
	return SUPPORTED_LOCALES.has(normalized) ? normalized : DEFAULT_LOCALE;
};

const CONTENT = {
	fr: {
		subject: 'Confirmez votre inscription à la newsletter Community',
		preheader:
			'Confirmez votre abonnement en un clic pour recevoir les nouveautés Community.',
		title: 'Confirmez votre inscription',
		lead:
			'Merci pour votre inscription à la newsletter Community. Un clic suffit pour activer votre abonnement.',
		benefitsTitle: 'Ce que vous recevrez',
		benefits: [
			'Les nouvelles fonctionnalités en avant-première',
			'Des annonces produit importantes',
			'Des conseils pour mieux utiliser Community',
		],
		cta: 'Confirmer mon inscription',
		fallbackTitle: 'Le bouton ne fonctionne pas ?',
		fallbackBody: 'Copiez-collez ce lien dans votre navigateur :',
		security:
			"Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email.",
		unsubscribe: 'Se désinscrire',
		copyright: 'Community. Tous droits réservés.',
	},
	en: {
		subject: 'Confirm your Community newsletter subscription',
		preheader:
			'Confirm your subscription in one click to receive Community updates.',
		title: 'Confirm your subscription',
		lead:
			'Thanks for subscribing to the Community newsletter. One click is enough to activate your subscription.',
		benefitsTitle: 'What you will receive',
		benefits: [
			'Early access to new features',
			'Important product announcements',
			'Practical tips to use Community better',
		],
		cta: 'Confirm my subscription',
		fallbackTitle: 'Button not working?',
		fallbackBody: 'Copy and paste this link into your browser:',
		security:
			'If you did not request this subscription, you can safely ignore this email.',
		unsubscribe: 'Unsubscribe',
		copyright: 'Community. All rights reserved.',
	},
	es: {
		subject: 'Confirma tu suscripcion al boletin de Community',
		preheader:
			'Confirma tu suscripcion con un clic para recibir novedades de Community.',
		title: 'Confirma tu suscripcion',
		lead:
			'Gracias por suscribirte al boletin de Community. Un clic es suficiente para activar tu suscripcion.',
		benefitsTitle: 'Lo que recibiras',
		benefits: [
			'Nuevas funciones en primicia',
			'Anuncios importantes del producto',
			'Consejos practicos para usar mejor Community',
		],
		cta: 'Confirmar mi suscripcion',
		fallbackTitle: 'El boton no funciona?',
		fallbackBody: 'Copia y pega este enlace en tu navegador:',
		security:
			'Si no solicitaste esta suscripcion, puedes ignorar este correo.',
		unsubscribe: 'Darse de baja',
		copyright: 'Community. Todos los derechos reservados.',
	},
	de: {
		subject: 'Bestaetigen Sie Ihr Community-Newsletter-Abonnement',
		preheader:
			'Bestaetigen Sie Ihr Abonnement mit einem Klick, um Community-Updates zu erhalten.',
		title: 'Abonnement bestaetigen',
		lead:
			'Vielen Dank fuer Ihre Anmeldung zum Community-Newsletter. Ein Klick aktiviert Ihr Abonnement.',
		benefitsTitle: 'Was Sie erhalten',
		benefits: [
			'Fruehen Zugriff auf neue Funktionen',
			'Wichtige Produktankuendigungen',
			'Praktische Tipps fuer Community',
		],
		cta: 'Mein Abonnement bestaetigen',
		fallbackTitle: 'Button funktioniert nicht?',
		fallbackBody: 'Kopieren Sie diesen Link in Ihren Browser:',
		security:
			'Wenn Sie diese Anmeldung nicht angefordert haben, koennen Sie diese E-Mail ignorieren.',
		unsubscribe: 'Abmelden',
		copyright: 'Community. Alle Rechte vorbehalten.',
	},
};

const buildTextBody = ({ content, confirmLink, unsubscribeLink }) => {
	const bulletLines = content.benefits.map((item) => `- ${item}`).join('\n');
	return [
		content.title,
		'',
		content.lead,
		'',
		`${content.benefitsTitle}:`,
		bulletLines,
		'',
		`${content.cta}: ${confirmLink}`,
		'',
		`${content.fallbackTitle} ${content.fallbackBody}`,
		confirmLink,
		'',
		content.security,
		'',
		`${content.unsubscribe}: ${unsubscribeLink}`,
	].join('\n');
};

const buildInlineLogoAttachment = () => {
	try {
		const logoBuffer = fs.readFileSync(LOGO_PATH);
		return {
			contentType: 'image/png',
			filename: 'community-logo.png',
			base64Content: logoBuffer.toString('base64'),
			contentId: INLINE_LOGO_CONTENT_ID,
		};
	} catch (_error) {
		return null;
	}
};

const buildNewsletterConfirmationEmail = ({
	locale,
	confirmLink,
	unsubscribeLink,
	frontendBase,
}) => {
	const normalizedLocale = normalizeLocale(locale);
	const content = CONTENT[normalizedLocale] || CONTENT[DEFAULT_LOCALE];
	const safeConfirmLink = escapeHtml(confirmLink);
	const safeUnsubscribeLink = escapeHtml(unsubscribeLink);
	const safeLogoUrl = escapeHtml(`${String(frontendBase || '').replace(/\/+$/, '')}/assets/logo.png`);
	const inlineLogoAttachment = buildInlineLogoAttachment();
	const safeLogoSrc = inlineLogoAttachment ?
		`cid:${INLINE_LOGO_CONTENT_ID}`
	:	safeLogoUrl;
	const year = new Date().getFullYear();
	const benefitsHtml = content.benefits
		.map((item) => `<li style="margin: 0 0 8px 0;">${escapeHtml(item)}</li>`)
		.join('');

	const html = `<!doctype html>
<html lang="${normalizedLocale}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(content.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f3f4ff;font-family:Segoe UI,Arial,sans-serif;color:${BRAND.ink};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(content.preheader)}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 12px;background:#f3f4ff;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;background:#ffffff;border:1px solid ${BRAND.border};border-radius:18px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px 16px 28px;border-bottom:3px solid ${BRAND.primary};background:${BRAND.panel};">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td width="56" style="vertical-align:middle;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="56">
                        <tr>
                          <td align="center" valign="middle" bgcolor="${BRAND.ink}" style="width:56px;height:56px;border-radius:16px;background:${BRAND.ink};">
                            <img src="${safeLogoSrc}" width="48" height="48" alt="Community" style="display:block;width:48px;height:48px;border:0;outline:none;text-decoration:none;border-radius:12px;" />
                          </td>
                        </tr>
                      </table>
                    </td>
                    <td style="padding-left:14px;vertical-align:middle;">
                      <div style="font-size:23px;font-weight:800;line-height:1.2;color:${BRAND.ink};letter-spacing:-0.01em;">Community</div>
                      <div style="font-size:13px;color:${BRAND.muted};">${escapeHtml(content.title)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 28px 10px 28px;">
                <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:${BRAND.ink};text-decoration:underline;text-decoration-color:${BRAND.primary};text-decoration-thickness:2px;">
                  ${escapeHtml(content.title)}
                </h1>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#1e293b;">${escapeHtml(content.lead)}</p>
                <p style="margin:0 0 10px 0;font-size:15px;line-height:1.5;color:${BRAND.ink};font-weight:700;">${escapeHtml(content.benefitsTitle)}</p>
                <ul style="margin:0 0 20px 20px;padding:0;font-size:15px;line-height:1.5;color:#334155;">
                  ${benefitsHtml}
                </ul>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">
                  <tr>
                    <td align="center" bgcolor="${BRAND.primary}" style="border-radius:999px;background:${BRAND.primary};box-shadow:0 8px 20px rgba(99,102,241,0.24);">
                      <a href="${safeConfirmLink}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;">
                        ${escapeHtml(content.cta)}
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};"><strong>${escapeHtml(content.fallbackTitle)}</strong> ${escapeHtml(content.fallbackBody)}</p>
                <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${safeConfirmLink}" style="color:${BRAND.primaryDark};text-decoration:underline;">${safeConfirmLink}</a></p>
                <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;color:${BRAND.muted};">${escapeHtml(content.security)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px 28px;background:${BRAND.panel};border-top:1px solid ${BRAND.border};">
                <p style="margin:0 0 6px 0;font-size:13px;color:${BRAND.muted};">
                  <a href="${safeUnsubscribeLink}" style="color:${BRAND.primaryDark};text-decoration:underline;">${escapeHtml(content.unsubscribe)}</a>
                </p>
                <p style="margin:0;font-size:12px;color:#64748b;">&copy; ${year} ${escapeHtml(content.copyright)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

	return {
		subject: content.subject,
		text: buildTextBody({ content, confirmLink, unsubscribeLink }),
		html,
		inlinedAttachments: [inlineLogoAttachment].filter(Boolean),
	};
};

module.exports = {
	buildNewsletterConfirmationEmail,
};
