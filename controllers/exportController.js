/** @format */

const { z } = require('zod');

const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const { resolveSurveyOrganizationId } = require('../services/surveyOrganizationService');
const { canManageSurveyByOrganization } = require('../services/surveyAuthorizationService');
const { authorizeAction } = require('../services/billing/entitlementService');
const { ENTITLEMENT_ACTIONS } = require('../services/billing/constants');
const { trackExport } = require('../services/billing/usageService');

const exportSchema = z.object({
	type: z.enum(['binary', 'multiple']),
	format: z.enum(['csv', 'json', 'pdf']).default('csv'),
	requestId: z.string().trim().min(8).max(160).optional(),
});

exports.requestSurveyExport = async (req, res) => {
	try {
		const parsed = exportSchema.safeParse(req.body || {});
		if (!parsed.success) {
			return res.status(400).json({
				message: 'Payload export invalide.',
				errors: parsed.error.flatten(),
			});
		}

		const surveyId = req.params.id;
		const SurveyModel = parsed.data.type === 'multiple' ? Survey_2 : Survey;
		const survey = await SurveyModel.findById(surveyId);
		if (!survey) {
			return res.status(404).json({ message: 'Sondage introuvable.' });
		}

		const canManageSurvey = await canManageSurveyByOrganization(survey, req.userId);
		if (!canManageSurvey) {
			return res.status(403).json({
				message: "Acces reserve au createur ou aux admins de l'organisation.",
			});
		}

		const organizationId = await resolveSurveyOrganizationId(survey);
		const entitlement = await authorizeAction({
			action: ENTITLEMENT_ACTIONS.EXPORT,
			organizationId,
			userId: req.userId,
			userEmail: req.userEmail || req.user?.email,
		});
		if (!entitlement.allowed) {
			return res.status(403).json({
				code: entitlement.code,
				message: entitlement.message,
			});
		}

		const requestId =
			parsed.data.requestId ||
			`export-${survey._id}-${parsed.data.format}-${Date.now()}`;

		await trackExport({
			organizationId,
			amount: 1,
			idempotencyKey: requestId,
			meta: {
				surveyId: String(survey._id),
				format: parsed.data.format,
				type: parsed.data.type,
				requestedBy: String(req.userId),
			},
		});

		return res.status(200).json({
			ok: true,
			surveyId: String(survey._id),
			type: parsed.data.type,
			format: parsed.data.format,
			requestId,
		});
	} catch (error) {
		console.error('export.requestSurveyExport:', error);
		return res.status(500).json({ message: 'Erreur serveur export.' });
	}
};
