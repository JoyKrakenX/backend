/** @format */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const User = require('../models/User');
const Survey = require('../models/Survey');
const Survey_2 = require('../models/Survey_2');
const {
	ensurePersonalOrganizationForUser,
} = require('../services/organizationService');

const run = async () => {
	await mongoose.connect(process.env.MONGO_URI);
	console.log('Connected to MongoDB.');

	const users = await User.find().lean();
	console.log(`Users found: ${users.length}`);

	let userUpdated = 0;
	for (const user of users) {
		const org = await ensurePersonalOrganizationForUser(user);
		if (org?._id) userUpdated += 1;
	}
	console.log(`Users organization ensured: ${userUpdated}`);

	const backfillSurveyOrg = async (Model, label) => {
		const surveys = await Model.find({
			$or: [{ organizationId: null }, { organizationId: { $exists: false } }],
		})
			.select('_id userId organizationId')
			.lean();

		let updated = 0;
		for (const survey of surveys) {
			const owner = await User.findById(survey.userId).lean();
			if (!owner) continue;
			const org = await ensurePersonalOrganizationForUser(owner);
			if (!org?._id) continue;
			await Model.updateOne(
				{ _id: survey._id },
				{ $set: { organizationId: org._id } },
			);
			updated += 1;
		}
		console.log(`${label} backfilled: ${updated}/${surveys.length}`);
	};

	await backfillSurveyOrg(Survey, 'Survey');
	await backfillSurveyOrg(Survey_2, 'Survey_2');

	await mongoose.disconnect();
	console.log('Migration completed.');
};

run().catch((error) => {
	console.error('Migration failed:', error);
	process.exit(1);
});
