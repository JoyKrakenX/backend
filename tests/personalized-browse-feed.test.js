const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const allSurveysController = read('controllers/allSurveys.js');
const surveyFeedHandlers = read('sockets/surveyFeedHandlers.js');
const requestValidators = read('middlewares/requestValidators.js');
const surveyController = read('controllers/survey.js');
const survey2Controller = read('controllers/survey_2.js');

assert.doesNotMatch(
	allSurveysController,
	/isSurveyPublic|isSurveyPrivate/,
	'all-surveys must not use public/private visibility to decide browse inclusion',
);

assert.match(
	allSurveysController,
	/participatedSurveyIdsByModel/,
	'all-surveys must build participation-based survey id groups before loading surveys',
);

assert.match(
	allSurveysController,
	/\$in:\s*participatedSurveyIdsByModel\.binary/,
	'all-surveys must query binary surveys by participated ids only',
);

assert.match(
	allSurveysController,
	/\$in:\s*participatedSurveyIdsByModel\.multiple/,
	'all-surveys must query multiple surveys by participated ids only',
);

assert.doesNotMatch(
	surveyFeedHandlers,
	/isSurveyPublic|isSurveyPrivate/,
	'survey feed realtime audience must not broadcast based on public/private visibility',
);

assert.doesNotMatch(
	requestValidators,
	/statusSchema|status:\s*statusSchema/,
	'create survey validators must not validate public/private status anymore',
);

[surveyController, survey2Controller].forEach((source, index) => {
	assert.doesNotMatch(
		source,
		/status:\s*normalizeSurveyStatus\(req\.body\.status\)/,
		`${index === 0 ? 'binary' : 'multiple'} creation must not persist request status`,
	);
});

console.log('personalized browse feed contract ok');
