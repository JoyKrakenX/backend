/** @format */

const OrganizationMember = require('../models/OrganizationMember');
const { resolveSurveyOrganizationId } = require('./surveyOrganizationService');

const isSurveyOwner = (survey, userId) =>
	Boolean(survey?._id) && String(survey?.userId || '') === String(userId || '');

const canManageSurveyByOrganization = async (survey, userId) => {
	if (!survey || !userId) return false;
	if (isSurveyOwner(survey, userId)) return true;

	const organizationId = await resolveSurveyOrganizationId(survey);
	if (!organizationId) return false;

	const member = await OrganizationMember.findOne({
		organizationId,
		userId,
	})
		.select('role')
		.lean();

	return ['owner', 'admin'].includes(String(member?.role || '').toLowerCase());
};

module.exports = {
	canManageSurveyByOrganization,
};

