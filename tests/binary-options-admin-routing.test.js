const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const surveyModel = read('models/Survey.js');
const surveyController = read('controllers/survey.js');
const flashController = read('controllers/surveyFlash.js');
const multipleController = read('controllers/survey_2.js');
const multipleFlashController = read('controllers/surveyFlash_2.js');
const qrRoute = read('routes/qrcode.js');

assert.match(surveyModel, /binaryLabels/, 'Survey model must store configurable binary labels');
assert.match(surveyController, /normalizeBinaryLabels/, 'classic binary creation must normalize binary labels');
assert.match(surveyController, /binaryLabels:\s*normalizeBinaryLabels/, 'classic binary creation must persist labels');
assert.match(flashController, /binaryLabels/, 'flash binary payloads must expose binary labels');

assert.match(
	qrRoute,
	/results:\s*'survey-results-admin\.html'/,
	'QR route must expose admin results as the results destination for every survey type',
);

[
	['classic binary', surveyController],
	['flash binary', flashController],
	['classic multiple', multipleController],
	['flash multiple', multipleFlashController],
].forEach(([label, source]) => {
	assert.match(
		source,
		/const canViewResults = hasParticipated;/,
		`${label} detailed admin results must require an actual vote`,
	);
	assert.match(
		source,
		/ADMIN_VOTE_REQUIRED/,
		`${label} detailed results must expose the admin vote gate reason`,
	);
});

console.log('binary options and admin routing contract ok');
