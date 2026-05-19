const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

assert.match(
	appSource,
	/scriptSrc:\s*\[[\s\S]*?'https:\/\/cdn\.jsdelivr\.net'/,
	'CSP script-src must allow jsDelivr because results snapshots load html2canvas at runtime',
);

console.log('security CSP share runtime contract ok');
