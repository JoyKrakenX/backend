/** @format */

const { z } = require('zod');

const statusSchema = z
	.string()
	.trim()
	.toLowerCase()
	.optional()
	.refine(
		(value) =>
			!value ||
			[
				'public',
				'privée',
				'privee',
				'private',
				'privé',
				'prive',
			].includes(value),
		{ message: 'Status de sondage invalide.' },
	);

const explainSchema = z.union([z.boolean(), z.string(), z.number()]).optional();

const createBinarySurveySchema = z.object({
	theme: z.string().trim().min(2).max(180),
	question: z.string().trim().min(3).max(600),
	contexte: z.string().trim().max(5000).optional().or(z.literal('')),
	explain: explainSchema,
	status: statusSchema,
	organizationId: z.string().trim().optional(),
});

const createMultipleSurveySchema = createBinarySurveySchema
	.extend({
		options: z.array(z.string().trim().min(1).max(220)).min(2).max(6).optional(),
		reponse_1: z.string().trim().max(220).optional(),
		reponse_2: z.string().trim().max(220).optional(),
		reponse_3: z.string().trim().max(220).optional(),
		reponse_4: z.string().trim().max(220).optional(),
		reponse_5: z.string().trim().max(220).optional(),
		reponse_6: z.string().trim().max(220).optional(),
	})
	.superRefine((data, ctx) => {
		const options = Array.isArray(data.options) ? data.options.filter(Boolean) : [];
		const legacy = [
			data.reponse_1,
			data.reponse_2,
			data.reponse_3,
			data.reponse_4,
			data.reponse_5,
			data.reponse_6,
		]
			.filter((entry) => String(entry || '').trim().length > 0)
			.map((entry) => String(entry).trim());
		const merged = options.length ? options : legacy;
		if (merged.length < 2) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['options'],
				message: 'Au moins deux options sont requises.',
			});
		}
	});

const binaryVoteSchema = z.object({
	answer: z.boolean(),
	reason: z.string().trim().max(2000).optional(),
	turnstileToken: z.string().trim().min(1).max(4096).optional(),
});

const multipleVoteSchema = z.object({
	choice: z.string().trim().min(1).max(280),
	reason: z.string().trim().max(2000).optional(),
	turnstileToken: z.string().trim().min(1).max(4096).optional(),
});

const chatSendSchema = z.object({
	message: z.string().trim().min(1).max(500),
	type: z.enum(['binary', 'multiple']).optional(),
	replyTo: z.string().trim().optional(),
});

const withZodValidation = (schema) => (req, res, next) => {
	const parsed = schema.safeParse(req.body || {});
	if (!parsed.success) {
		return res.status(400).json({
			message: 'Payload invalide.',
			errors: parsed.error.flatten(),
		});
	}
	req.body = {
		...req.body,
		...parsed.data,
	};
	return next();
};

module.exports = {
	validateCreateBinarySurvey: withZodValidation(createBinarySurveySchema),
	validateCreateMultipleSurvey: withZodValidation(createMultipleSurveySchema),
	validateBinaryVote: withZodValidation(binaryVoteSchema),
	validateMultipleVote: withZodValidation(multipleVoteSchema),
	validateChatSendMessage: withZodValidation(chatSendSchema),
};
