/** @format */

const User = require('../models/User');
const { ensurePersonalOrganizationForUser } = require('./organizationService');

const resolveSurveyOrganizationId = async (surveyDocumentOrLean) => {
	if (!surveyDocumentOrLean) return null;
	if (surveyDocumentOrLean.organizationId) {
		return surveyDocumentOrLean.organizationId;
	}

	const ownerUserId = surveyDocumentOrLean.userId;
	if (!ownerUserId) return null;

	let owner = await User.findById(ownerUserId).lean();
	if (!owner) return null;
	const organization = await ensurePersonalOrganizationForUser(owner);
	owner = await User.findById(ownerUserId).lean();
	const organizationId = organization?._id || owner?.defaultOrganizationId || null;

	if (
		organizationId &&
		typeof surveyDocumentOrLean.save === 'function' &&
		!surveyDocumentOrLean.organizationId
	) {
		surveyDocumentOrLean.organizationId = organizationId;
		await surveyDocumentOrLean.save();
	}

	return organizationId;
};

module.exports = {
	resolveSurveyOrganizationId,
};
