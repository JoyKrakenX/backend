/** @format */

const DEFAULT_LOCALE = 'fr';
const SUPPORTED_LOCALES = new Set(['fr', 'en', 'es', 'de']);

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
		subject: 'Confirmez votre inscription a la newsletter SurveyApp',
		preheader:
			'Confirmez votre abonnement en un clic pour recevoir les nouveautes SurveyApp.',
		title: 'Confirmez votre inscription',
		lead:
			'Merci pour votre inscription a la newsletter SurveyApp. Un clic suffit pour activer votre abonnement.',
		benefitsTitle: 'Ce que vous recevrez',
		benefits: [
			'Les nouvelles fonctionnalites en avant-premiere',
			'Des annonces produit importantes',
			'Des conseils pour mieux utiliser SurveyApp',
		],
		cta: 'Confirmer mon inscription',
		fallbackTitle: 'Le bouton ne fonctionne pas ?',
		fallbackBody: 'Copiez-collez ce lien dans votre navigateur :',
		security:
			"Si vous n'etes pas a l'origine de cette demande, ignorez simplement cet email.",
		unsubscribe: 'Se desinscrire',
		copyright: 'SurveyApp. Tous droits reserves.',
	},
	en: {
		subject: 'Confirm your SurveyApp newsletter subscription',
		preheader:
			'Confirm your subscription in one click to receive SurveyApp updates.',
		title: 'Confirm your subscription',
		lead:
			'Thanks for subscribing to the SurveyApp newsletter. One click is enough to activate your subscription.',
		benefitsTitle: 'What you will receive',
		benefits: [
			'Early access to new features',
			'Important product announcements',
			'Practical tips to use SurveyApp better',
		],
		cta: 'Confirm my subscription',
		fallbackTitle: 'Button not working?',
		fallbackBody: 'Copy and paste this link into your browser:',
		security:
			'If you did not request this subscription, you can safely ignore this email.',
		unsubscribe: 'Unsubscribe',
		copyright: 'SurveyApp. All rights reserved.',
	},
	es: {
		subject: 'Confirma tu suscripcion al boletin de SurveyApp',
		preheader:
			'Confirma tu suscripcion con un clic para recibir novedades de SurveyApp.',
		title: 'Confirma tu suscripcion',
		lead:
			'Gracias por suscribirte al boletin de SurveyApp. Un clic es suficiente para activar tu suscripcion.',
		benefitsTitle: 'Lo que recibiras',
		benefits: [
			'Nuevas funciones en primicia',
			'Anuncios importantes del producto',
			'Consejos practicos para usar mejor SurveyApp',
		],
		cta: 'Confirmar mi suscripcion',
		fallbackTitle: 'El boton no funciona?',
		fallbackBody: 'Copia y pega este enlace en tu navegador:',
		security:
			'Si no solicitaste esta suscripcion, puedes ignorar este correo.',
		unsubscribe: 'Darse de baja',
		copyright: 'SurveyApp. Todos los derechos reservados.',
	},
	de: {
		subject: 'Bestaetigen Sie Ihr SurveyApp-Newsletter-Abonnement',
		preheader:
			'Bestaetigen Sie Ihr Abonnement mit einem Klick, um SurveyApp-Updates zu erhalten.',
		title: 'Abonnement bestaetigen',
		lead:
			'Vielen Dank fuer Ihre Anmeldung zum SurveyApp-Newsletter. Ein Klick aktiviert Ihr Abonnement.',
		benefitsTitle: 'Was Sie erhalten',
		benefits: [
			'Fruehen Zugriff auf neue Funktionen',
			'Wichtige Produktankuendigungen',
			'Praktische Tipps fuer SurveyApp',
		],
		cta: 'Mein Abonnement bestaetigen',
		fallbackTitle: 'Button funktioniert nicht?',
		fallbackBody: 'Kopieren Sie diesen Link in Ihren Browser:',
		security:
			'Wenn Sie diese Anmeldung nicht angefordert haben, koennen Sie diese E-Mail ignorieren.',
		unsubscribe: 'Abmelden',
		copyright: 'SurveyApp. Alle Rechte vorbehalten.',
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
  <body style="margin:0;padding:0;background:#f3f7fb;font-family:Segoe UI,Arial,sans-serif;color:#0f172a;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
      ${escapeHtml(content.preheader)}
    </div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:24px 12px;background:#f3f7fb;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:24px 28px 14px 28px;border-bottom:2px solid #0f766e;background:#f8fafc;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${safeLogoUrl}" width="42" height="42" alt="SurveyApp" style="display:block;border:0;outline:none;text-decoration:none;" />
                    </td>
                    <td style="padding-left:12px;vertical-align:middle;">
                      <div style="font-size:22px;font-weight:700;line-height:1.2;color:#0f172a;">SurveyApp</div>
                      <div style="font-size:13px;color:#334155;">${escapeHtml(content.title)}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 28px 10px 28px;">
                <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:#0f172a;text-decoration:underline;text-decoration-color:#0f766e;text-decoration-thickness:2px;">
                  ${escapeHtml(content.title)}
                </h1>
                <p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:#1e293b;">${escapeHtml(content.lead)}</p>
                <p style="margin:0 0 10px 0;font-size:15px;line-height:1.5;color:#0f172a;font-weight:600;">${escapeHtml(content.benefitsTitle)}</p>
                <ul style="margin:0 0 20px 20px;padding:0;font-size:15px;line-height:1.5;color:#334155;">
                  ${benefitsHtml}
                </ul>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px 0;">
                  <tr>
                    <td align="center" bgcolor="#0f766e" style="border-radius:999px;">
                      <a href="${safeConfirmLink}" style="display:inline-block;padding:12px 24px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;">
                        ${escapeHtml(content.cta)}
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 6px 0;font-size:13px;line-height:1.5;color:#475569;"><strong>${escapeHtml(content.fallbackTitle)}</strong> ${escapeHtml(content.fallbackBody)}</p>
                <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${safeConfirmLink}" style="color:#0f766e;text-decoration:underline;">${safeConfirmLink}</a></p>
                <p style="margin:0 0 14px 0;font-size:13px;line-height:1.5;color:#475569;">${escapeHtml(content.security)}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;">
                <p style="margin:0 0 6px 0;font-size:13px;color:#475569;">
                  <a href="${safeUnsubscribeLink}" style="color:#0f766e;text-decoration:underline;">${escapeHtml(content.unsubscribe)}</a>
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
	};
};

module.exports = {
	buildNewsletterConfirmationEmail,
};
