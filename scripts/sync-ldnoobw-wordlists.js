/** @format */

const fs = require('fs');
const path = require('path');
const https = require('https');

const COMMIT = '5faf2ba42d7b1c0977169ec3611df25a3c08eb13';
const LOCALES = ['fr', 'en', 'es', 'de'];
const TARGET_DIR = path.join(__dirname, '../data/moderation/ldnoobw');

const download = (url) =>
	new Promise((resolve, reject) => {
		https
			.get(
				url,
				{
					headers: {
						'User-Agent': 'Community-Codex',
					},
				},
				(response) => {
					if (response.statusCode !== 200) {
						reject(new Error(`LDNOOBW download failed: ${response.statusCode}`));
						response.resume();
						return;
					}
					const chunks = [];
					response.on('data', (chunk) => chunks.push(chunk));
					response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
				},
			)
			.on('error', reject);
	});

const run = async () => {
	fs.mkdirSync(TARGET_DIR, { recursive: true });

	for (const locale of LOCALES) {
		const url = `https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/${COMMIT}/${locale}`;
		const content = await download(url);
		fs.writeFileSync(path.join(TARGET_DIR, `${locale}.txt`), content, 'utf8');
		console.log(`Synced LDNOOBW ${locale}`);
	}
};

run().catch((error) => {
	console.error(error?.message || error);
	process.exit(1);
});
