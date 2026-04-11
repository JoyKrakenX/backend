const test = require('node:test');
const assert = require('node:assert/strict');

const {
	SURVEY_COMMENT_ERROR_CODES,
	createSurveyCommentModerationError,
	assertOpinionCommentInteractable,
	prepareOpinionsForSurveyView,
	applyOpinionCommentDeletion,
	restoreOpinionComment,
	buildAutoModerationCommentFields,
	buildCommentSubmissionModerationPayload,
	__test__,
} = require('../services/surveyCommentModerationService');

const { buildCommentModerationPayload, validateOpinionCommentModerationTarget } =
	__test__;

test('prepareOpinionsForSurveyView keeps the real pseudo on screen and export alias separately', () => {
	const opinions = [
		{
			_id: 'op1',
			surveyId: 'survey-123',
			userId: '507f1f77bcf86cd799439011',
			userPseudo: 'Awa',
			answer: true,
			reason: 'Je suis pour.',
			createdAt: '2026-04-10T09:00:00.000Z',
		},
	];

	const [result] = prepareOpinionsForSurveyView(opinions, 'survey-123', {
		includeExportPseudo: true,
		requesterUserId: '507f1f77bcf86cd799439011',
	});

	assert.equal(result.userPseudo, 'Awa');
	assert.notEqual(result.exportUserPseudo, 'Awa');
	assert.equal(result.reason, 'Je suis pour.');
	assert.equal(result.commentVisible, true);
	assert.equal(result.isOwnOpinion, true);
});

test('prepareOpinionsForSurveyView hides deleted comment text but keeps the vote record', () => {
	const opinions = [
		{
			_id: 'op2',
			surveyId: 'survey-123',
			userId: '507f1f77bcf86cd799439012',
			userPseudo: 'Moussa',
			answer: false,
			reason: 'Commentaire retire.',
			commentDeletedAt: '2026-04-10T09:10:00.000Z',
			createdAt: '2026-04-10T09:00:00.000Z',
		},
	];

	const [result] = prepareOpinionsForSurveyView(opinions, 'survey-123');

	assert.equal(result.userPseudo, 'Moussa');
	assert.equal(result.reason, '');
	assert.equal(result.commentVisible, false);
	assert.deepEqual(result.commentModeration, {
		isDeleted: true,
		deletedAt: '2026-04-10T09:10:00.000Z',
		deletedSource: 'manual',
		moderationSource: null,
		reasonCodes: [],
		canRestore: false,
	});
});

test('buildCommentModerationPayload marks a deleted comment with stable metadata', () => {
	const payload = buildCommentModerationPayload({
		commentDeletedAt: '2026-04-10T09:10:00.000Z',
	});

	assert.deepEqual(payload, {
		isDeleted: true,
		deletedAt: '2026-04-10T09:10:00.000Z',
		deletedSource: 'manual',
		moderationSource: null,
		reasonCodes: [],
		canRestore: false,
	});
});

test('validateOpinionCommentModerationTarget rejects non moderators and already deleted comments', () => {
	assert.throws(
		() =>
			validateOpinionCommentModerationTarget({
				survey: { _id: 'survey-123' },
				opinion: {
					_id: 'op3',
					surveyId: 'survey-123',
					reason: 'Texte',
				},
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: false,
			}),
		(error) =>
			error.status === 403 &&
			error.code === SURVEY_COMMENT_ERROR_CODES.MODERATION_FORBIDDEN,
	);

	assert.throws(
		() =>
			validateOpinionCommentModerationTarget({
				survey: { _id: 'survey-123' },
				opinion: {
					_id: 'op3',
					surveyId: 'survey-123',
					reason: 'Texte',
					commentDeletedAt: '2026-04-10T09:10:00.000Z',
				},
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: true,
			}),
		(error) =>
			error.status === 409 &&
			error.code === SURVEY_COMMENT_ERROR_CODES.COMMENT_ALREADY_DELETED,
	);
});

test('validateOpinionCommentModerationTarget rejects comments without visible text', () => {
	assert.throws(
		() =>
			validateOpinionCommentModerationTarget({
				survey: { _id: 'survey-123' },
				opinion: {
					_id: 'op4',
					surveyId: 'survey-123',
					reason: '   ',
				},
				actorUserId: '507f1f77bcf86cd799439099',
				canModerate: true,
			}),
		(error) =>
			error.status === 409 &&
			error.code === SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE,
	);
});

test('assertOpinionCommentInteractable rejects deleted or missing comments', () => {
	assert.throws(
		() => assertOpinionCommentInteractable(null),
		(error) =>
			error.status === 404 &&
			error.code === SURVEY_COMMENT_ERROR_CODES.COMMENT_NOT_FOUND,
	);

	assert.throws(
		() =>
			assertOpinionCommentInteractable({
				_id: 'op5',
				reason: 'Texte',
				commentDeletedAt: '2026-04-10T09:10:00.000Z',
			}),
		(error) =>
			error.status === 410 &&
			error.code === SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE,
	);
});

test('applyOpinionCommentDeletion soft deletes only the comment content metadata', async () => {
	const opinion = {
		_id: 'op6',
		surveyId: 'survey-123',
		reason: 'Je participe.',
		commentDeletedAt: null,
		commentDeletedBy: null,
		saveCalls: 0,
		async save() {
			this.saveCalls += 1;
		},
	};
	const actorUserId = '507f1f77bcf86cd799439099';
	const now = new Date('2026-04-10T10:00:00.000Z');

	const result = await applyOpinionCommentDeletion({
		opinion,
		actorUserId,
		now,
	});

	assert.equal(opinion.commentDeletedBy, actorUserId);
	assert.deepEqual(opinion.commentDeletedAt, now);
	assert.equal(opinion.commentDeletedSource, 'manual');
	assert.equal(opinion.saveCalls, 1);
	assert.deepEqual(result, {
		opinionId: 'op6',
		surveyId: 'survey-123',
		deletedAt: '2026-04-10T10:00:00.000Z',
		deletedSource: 'manual',
	});
});

test('createSurveyCommentModerationError keeps stable HTTP metadata', () => {
	const error = createSurveyCommentModerationError(
		409,
		SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE,
		'Comment unavailable for tests',
	);

	assert.equal(error.status, 409);
	assert.equal(error.code, SURVEY_COMMENT_ERROR_CODES.COMMENT_UNAVAILABLE);
	assert.equal(error.message, 'Comment unavailable for tests');
});

test('buildAutoModerationCommentFields returns auto deletion metadata only when enforced', () => {
	const now = new Date('2026-04-10T10:30:00.000Z');
	const fields = buildAutoModerationCommentFields({
		decision: {
			appliedVerdict: 'auto_hide_comment',
			reasonCodes: ['LDNOOBW_EXACT_MATCH'],
			source: 'ldnoobw',
			locale: 'fr',
		},
		logEntry: { _id: 'moderation-log-1' },
		now,
	});

	assert.deepEqual(fields, {
		commentDeletedAt: now,
		commentDeletedBy: null,
		commentDeletedSource: 'auto',
		commentModerationLogId: 'moderation-log-1',
		commentModerationReasonCodes: ['LDNOOBW_EXACT_MATCH'],
		commentModerationSource: 'ldnoobw',
		commentModerationLocale: 'fr',
	});
});

test('buildCommentSubmissionModerationPayload exposes auto hidden state', () => {
	assert.deepEqual(
		buildCommentSubmissionModerationPayload({
			commentDeletedAt: '2026-04-10T09:10:00.000Z',
			commentDeletedSource: 'auto',
		}),
		{
			state: 'auto_hidden',
			source: 'auto',
		},
	);

	assert.deepEqual(
		buildCommentSubmissionModerationPayload({
			commentDeletedAt: null,
			commentDeletedSource: null,
		}),
		{
			state: 'visible',
			source: null,
		},
	);
});

test('restoreOpinionComment restores only auto-moderated comments', async () => {
	const opinion = {
		_id: 'op7',
		surveyId: 'survey-123',
		reason: 'Texte masque automatiquement',
		commentDeletedAt: '2026-04-10T09:10:00.000Z',
		commentDeletedBy: null,
		commentDeletedSource: 'auto',
		commentModerationLogId: 'log-1',
		commentModerationReasonCodes: ['OPENAI_HATE'],
		commentModerationSource: 'openai',
		commentModerationLocale: 'fr',
		saveCalls: 0,
		async save() {
			this.saveCalls += 1;
		},
	};

	const result = await restoreOpinionComment({
		opinion,
		actorUserId: '507f1f77bcf86cd799439099',
		now: new Date('2026-04-10T11:00:00.000Z'),
	});

	assert.equal(opinion.commentDeletedAt, null);
	assert.equal(opinion.commentDeletedBy, null);
	assert.equal(opinion.commentDeletedSource, null);
	assert.equal(opinion.commentModerationLogId, null);
	assert.deepEqual(opinion.commentModerationReasonCodes, []);
	assert.equal(opinion.commentModerationSource, null);
	assert.equal(opinion.commentModerationLocale, null);
	assert.equal(opinion.saveCalls, 1);
	assert.deepEqual(result, {
		opinionId: 'op7',
		surveyId: 'survey-123',
		restoredAt: '2026-04-10T11:00:00.000Z',
		restoredBy: '507f1f77bcf86cd799439099',
	});
});
